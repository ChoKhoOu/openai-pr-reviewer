import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/action'
import {ChatGPTError} from 'chatgpt'
import pLimit from 'p-limit'
import {Bot} from './bot.js'
import {Commenter, COMMENT_REPLY_TAG, SUMMARIZE_TAG} from './commenter.js'
import {Inputs, Options, Prompts} from './options.js'
import * as tokenizer from './tokenizer.js'

const token = core.getInput('token')
  ? core.getInput('token')
  : process.env.GITHUB_TOKEN
const octokit = new Octokit({auth: `token ${token}`})
const context = github.context
const repo = context.repo

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts
): Promise<void> => {
  const commenter: Commenter = new Commenter()

  const openai_concurrency_limit = pLimit(options.openai_concurrency_limit)

  if (
    context.eventName !== 'pull_request' &&
    context.eventName !== 'pull_request_target'
  ) {
    core.warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return
  }
  if (!context.payload.pull_request) {
    core.warning(`Skipped: context.payload.pull_request is null`)
    return
  }

  const inputs: Inputs = new Inputs()
  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body) {
    inputs.description = commenter.get_description(
      context.payload.pull_request.body
    )
  }
  // as gpt-3.5-turbo isn't paying attention to system message, add to inputs for now
  inputs.system_message = options.system_message

  // collect diff chunks
  const diff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: context.payload.pull_request.base.sha,
    head: context.payload.pull_request.head.sha
  })
  const {files, commits} = diff.data
  if (!files) {
    core.warning(`Skipped: diff.data.files is null`)
    await commenter.comment(
      `Skipped: no files to review`,
      SUMMARIZE_TAG,
      'replace'
    )
    return
  }

  // skip files if they are filtered out
  const filter_selected_files = []
  const filter_ignored_files = []
  for (const file of files) {
    if (!options.check_path(file.filename)) {
      core.info(`skip for excluded path: ${file.filename}`)
      filter_ignored_files.push(file)
    } else {
      filter_selected_files.push(file)
    }
  }

  // find patches to review
  const filtered_files_to_review: (
    | [string, string, string, [number, number, string][]]
    | null
  )[] = await Promise.all(
    filter_selected_files.map(async file => {
      // retrieve file contents
      let file_content = ''
      if (!context.payload.pull_request) {
        core.warning(`Skipped: context.payload.pull_request is null`)
        return null
      }
      try {
        const contents = await octokit.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: file.filename,
          ref: context.payload.pull_request.base.sha
        })
        if (contents.data) {
          if (!Array.isArray(contents.data)) {
            if (contents.data.type === 'file' && contents.data.content) {
              file_content = Buffer.from(
                contents.data.content,
                'base64'
              ).toString()
            }
          }
        }
      } catch (error) {
        core.warning(`Failed to get file contents: ${error}, skipping.`)
      }

      let file_diff = ''
      if (file.patch) {
        file_diff = file.patch
      }

      const patches: [number, number, string][] = []
      for (const patch of split_patch(file.patch)) {
        const patch_lines = patch_start_end_line(patch)
        if (
          !patch_lines ||
          patch_lines.start_line === -1 ||
          patch_lines.end_line === -1
        ) {
          continue
        }
        patches.push([patch_lines.start_line, patch_lines.end_line, patch])
      }
      if (patches.length > 0) {
        return [file.filename, file_content, file_diff, patches]
      } else {
        return null
      }
    })
  )

  // Filter out any null results
  const files_to_review = filtered_files_to_review.filter(
    file => file !== null
  ) as [string, string, string, [number, number, string][]][]

  if (files_to_review.length > 0) {
    const generateSummary = async (
      filename: string,
      file_content: string,
      file_diff: string
    ): Promise<[string, string] | null> => {
      const ins = inputs.clone()
      ins.filename = filename

      if (file_content.length > 0) {
        if (
          tokenizer.get_token_count(file_content) <
          options.light_token_limits.extra_content_tokens
        ) {
          ins.file_content = file_content
        }
      }

      if (file_diff.length > 0) {
        ins.file_diff = file_diff
      }

      // Check if there is either file content or file diff to process
      if (ins.file_content || ins.file_diff) {
        const file_diff_tokens = tokenizer.get_token_count(file_diff)

        if (
          !ins.file_diff ||
          file_diff_tokens < options.light_token_limits.extra_content_tokens
        ) {
          // summarize content
          try {
            const [summarize_resp] = await lightBot.chat(
              prompts.render_summarize_file_diff(ins),
              {}
            )

            if (!summarize_resp) {
              core.info('summarize: nothing obtained from openai')
              return null
            } else {
              return [filename, summarize_resp]
            }
          } catch (error) {
            core.warning(`summarize: error from openai: ${error}`)
            return null
          }
        }
      }
      return null
    }

    const summaryPromises = []
    const skipped_files_to_summarize = []
    for (const [filename, file_content, file_diff] of files_to_review) {
      if (
        options.max_files_to_summarize <= 0 ||
        summaryPromises.length < options.max_files_to_summarize
      ) {
        summaryPromises.push(
          openai_concurrency_limit(async () =>
            generateSummary(filename, file_content, file_diff)
          )
        )
      } else {
        skipped_files_to_summarize.push(filename)
      }
    }

    const summaries = (await Promise.all(summaryPromises)).filter(
      summary => summary !== null
    ) as [string, string][]

    if (summaries.length > 0) {
      inputs.summary = ''
      // join summaries into one
      for (const [filename, summary] of summaries) {
        inputs.summary += `---
${filename}: ${summary}
`
      }
    }

    let next_summarize_ids = {}

    // final summary
    const [summarize_final_response, summarize_final_response_ids] =
      await heavyBot.chat(prompts.render_summarize(inputs), next_summarize_ids)
    if (!summarize_final_response) {
      core.info('summarize: nothing obtained from openai')
    } else {
      inputs.summary = summarize_final_response

      const summarize_comment = `${summarize_final_response}

---

### Chat with 🤖 OpenAI Bot (\`@openai\`)
- Reply on review comments left by this bot to ask follow-up questions. A review comment is a comment on a diff or a file.
- Invite the bot into a review comment chain by tagging \`@openai\` in a reply.

---

${
  filter_ignored_files.length > 0
    ? `
<details>
<summary>Files ignored due to filter (${filter_ignored_files.length})</summary>

### Ignored files

* ${filter_ignored_files.map(file => file.filename).join('\n* ')}

</details>
`
    : ''
}

${
  skipped_files_to_summarize.length > 0
    ? `
<details>
<summary>Files not summarized due to max files limit (${
        skipped_files_to_summarize.length
      })</summary>

### Not summarized

* ${skipped_files_to_summarize.join('\n* ')}

</details>
`
    : ''
}
`

      await commenter.comment(`${summarize_comment}`, SUMMARIZE_TAG, 'replace')

      // final release notes
      next_summarize_ids = summarize_final_response_ids
      const [release_notes_response, release_notes_ids] = await heavyBot.chat(
        prompts.render_summarize_release_notes(inputs),
        next_summarize_ids
      )
      if (!release_notes_response) {
        core.info('release notes: nothing obtained from openai')
      } else {
        next_summarize_ids = release_notes_ids
        let message = '### Summary by OpenAI\n\n'
        message += release_notes_response
        commenter.update_description(
          context.payload.pull_request.number,
          message
        )
      }
    }

    if (options.summary_only === true) {
      core.info('summary_only is true, exiting')
      return
    }

    const do_review = async (
      filename: string,
      file_content: string,
      patches: [number, number, string][]
    ): Promise<void> => {
      // make a copy of inputs
      const ins: Inputs = inputs.clone()

      ins.filename = filename

      if (file_content.length > 0) {
        const file_content_tokens = tokenizer.get_token_count(file_content)
        if (
          file_content_tokens < options.heavy_token_limits.extra_content_tokens
        ) {
          ins.file_content = file_content
        } else {
          core.info(
            `skip sending content of file: ${ins.filename} due to token count: ${file_content_tokens}`
          )
        }
      }

      for (const [start_line, end_line, patch] of patches) {
        if (!context.payload.pull_request) {
          core.warning('No pull request found, skipping.')
          continue
        }
        let comment_chain = 'no comments on this patch'
        try {
          // get existing comments on the line
          const all_chains = await commenter.get_conversation_chains_at_range(
            context.payload.pull_request.number,
            filename,
            start_line,
            end_line,
            COMMENT_REPLY_TAG
          )

          if (all_chains.length > 0) {
            comment_chain = all_chains
          } else {
            comment_chain = ''
          }
        } catch (e: unknown) {
          if (e instanceof ChatGPTError) {
            core.warning(
              `Failed to get comments: ${e}, skipping. backtrace: ${e.stack}`
            )
          }
        }
        ins.patches += `
${start_line}-${end_line}:
\`\`\`diff
${patch}
\`\`\`
`
        if (comment_chain !== '') {
          ins.patches += `
\`\`\`text
${comment_chain}
\`\`\`
`
        }

        ins.patches += `
---
`
      }
      // perform review
      try {
        const [response] = await heavyBot.chat(
          prompts.render_review_file_diff(ins),
          {}
        )
        if (!response) {
          core.info('review: nothing obtained from openai')
          return
        }
        // parse review
        const reviewMap = parseOpenAIReview(response, options.debug)
        for (const [, review] of reviewMap) {
          // check for LGTM
          if (
            !options.review_comment_lgtm &&
            (review.comment.includes('LGTM') ||
              review.comment.includes('looks good to me'))
          ) {
            continue
          }
          if (!context.payload.pull_request) {
            core.warning('No pull request found, skipping.')
            continue
          }
          await commenter.review_comment(
            context.payload.pull_request.number,
            commits[commits.length - 1].sha,
            filename,
            review.start_line,
            review.end_line,
            `${review.comment}`
          )
        }
      } catch (e: any) {
        core.warning(`Failed to review: ${e}, skipping. backtrace: ${e.stack}`)
      }
    }

    const reviewPromises = []
    const skipped_files_to_review = []
    for (const [filename, file_content, , patches] of files_to_review) {
      if (
        options.max_files_to_review <= 0 ||
        reviewPromises.length < options.max_files_to_review
      ) {
        reviewPromises.push(
          openai_concurrency_limit(async () =>
            do_review(filename, file_content, patches)
          )
        )
      } else {
        skipped_files_to_review.push(filename)
      }
    }

    await Promise.all(reviewPromises)

    // comment about skipped files for review and summarize
    if (skipped_files_to_review.length > 0) {
      // make bullet points for skipped files
      const comment = `
      ${
        skipped_files_to_review.length > 0
          ? `<details>
<summary>Files not reviewed due to max files limit (${
              skipped_files_to_review.length
            })</summary>

### Not reviewed

* ${skipped_files_to_review.join('\n* ')}

</details>
`
          : ''
      }
      `
      if (comment.length > 0) {
        await commenter.comment(comment, SUMMARIZE_TAG, 'append')
      }
    }
  }
}

const split_patch = (patch: string | null | undefined): string[] => {
  if (!patch) {
    return []
  }

  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@).*$/gm

  const result: string[] = []
  let last = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(patch)) !== null) {
    if (last === -1) {
      last = match.index
    } else {
      result.push(patch.substring(last, match.index))
      last = match.index
    }
  }
  if (last !== -1) {
    result.push(patch.substring(last))
  }
  return result
}

const patch_start_end_line = (
  patch: string
): {start_line: number; end_line: number} | null => {
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/gm
  const match = pattern.exec(patch)
  if (match) {
    const begin = parseInt(match[4])
    const diff = parseInt(match[5])
    return {
      start_line: begin,
      end_line: begin + diff - 1
    }
  } else {
    return null
  }
}

type Review = {
  start_line: number
  end_line: number
  comment: string
}

function parseOpenAIReview(
  response: string,
  debug = false
): Map<string, Review> {
  const reviews = new Map<string, Review>()

  // Split the response into lines
  const lines = response.split('\n')

  // Regular expression to match the line number range and comment format
  const lineNumberRangeRegex = /(?:^|\s)(\d+)-(\d+):\s*$/
  const commentSeparator = '---'

  let currentStartLine: number | null = null
  let currentEndLine: number | null = null
  let currentComment = ''

  for (const line of lines) {
    // Check if the line matches the line number range format
    const lineNumberRangeMatch = line.match(lineNumberRangeRegex)

    if (lineNumberRangeMatch) {
      // If there is a previous comment, store it in the reviews Map
      if (currentStartLine !== null && currentEndLine !== null) {
        reviews.set(`${currentStartLine}-${currentEndLine}`, {
          start_line: currentStartLine,
          end_line: currentEndLine,
          comment: currentComment.trim()
        })
        debug &&
          core.info(
            `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
          )
      }

      // Set the current line number range and reset the comment
      currentStartLine = parseInt(lineNumberRangeMatch[1], 10)
      currentEndLine = parseInt(lineNumberRangeMatch[2], 10)
      currentComment = ''
      debug &&
        core.info(
          `Found line number range: ${currentStartLine}-${currentEndLine}`
        )
      continue
    }

    // Check if the line is a comment separator
    if (line.trim() === commentSeparator) {
      // If there is a previous comment, store it in the reviews Map
      if (currentStartLine !== null && currentEndLine !== null) {
        reviews.set(`${currentStartLine}-${currentEndLine}`, {
          start_line: currentStartLine,
          end_line: currentEndLine,
          comment: currentComment.trim()
        })
        debug &&
          core.info(
            `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
          )
      }

      // Reset the current line number range and comment
      currentStartLine = null
      currentEndLine = null
      currentComment = ''
      debug && core.info('Found comment separator')
      continue
    }

    // If there is a current line number range, add the line to the current comment
    if (currentStartLine !== null && currentEndLine !== null) {
      currentComment += `${line}\n`
    }
  }

  // If there is a comment at the end of the response, store it in the reviews Map
  if (currentStartLine !== null && currentEndLine !== null) {
    reviews.set(`${currentStartLine}-${currentEndLine}`, {
      start_line: currentStartLine,
      end_line: currentEndLine,
      comment: currentComment.trim()
    })
    debug &&
      core.info(
        `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
      )
  }

  return reviews
}
