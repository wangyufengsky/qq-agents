// @ts-check
// Report actionable validation bounds without echoing input values, paths,
// stack traces, provider errors or credentials into either model backend.
/** @param {any} error */
export function safeToolFailure(error) {
  if (/^ANTIGRAVITY_MEDIA_(FORMAT|LIMIT|FAILED)$/.test(error?.message || ""))
    return {
      code: error.message,
      hint: "Image pixels were not delivered. Do not describe them. Request fewer or smaller static PNG/JPEG/WebP images. GIFs must use the bridge decoder; request one frame at a time with animation.mode=frames and limit=1. Never read an unregistered path or reuse one from an earlier turn.",
    };
  if (
    /^(ANIMATION_[A-Z_]+|INVALID_GIF|INVALID_ANIMATION_RANGE)$/.test(
      error?.message || "",
    )
  )
    return {
      code: error.message,
      hint: "Animation frames were not read. Do not describe motion or silently treat it as a still. For invalid ranges, omit animation options to get an overview and duration first. Missing decoder requires an administrator to install/configure FFmpeg. Other animated formats currently require a GIF source; processing limits or decode errors do not mean the source is static.",
    };
  if (error?.name === "ZodError" && Array.isArray(error.issues))
    return {
      code: "INVALID_TOOL_ARGUMENTS",
      issues: error.issues.slice(0, 8).map((/** @type {any} */ issue) => ({
        field: (issue.path || [])
          .filter(
            (/** @type {unknown} */ p) =>
              typeof p === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p),
          )
          .slice(0, 4)
          .join("."),
        code: [
          "too_big",
          "too_small",
          "invalid_type",
          "invalid_value",
          "unrecognized_keys",
        ].includes(issue.code)
          ? issue.code
          : "invalid_argument",
        ...(Number.isFinite(issue.minimum) ? { minimum: issue.minimum } : {}),
        ...(Number.isFinite(issue.maximum) ? { maximum: issue.maximum } : {}),
      })),
      hint: "Correct the named arguments within these bounds, or omit optional budgets and use pagination. The operation did not succeed. Do not infer unread content or claim successful delivery.",
    };
  /** @type {Record<string, string>} */
  const hints = {
    INVALID_MEMORY_SCOPE:
      "The source selector is invalid, not an empty memory result. memory_search conversationType=group/private filters a kind of chat. conversation must be an exact source key such as group:20000 or private:30000; do not use group/private or wildcard keys. Omit conversation to search your own memories across chats, then use the returned source key. conversation_read without conversation only reads the current chat. Keep protected-source restrictions unchanged.",
    DELIVERY_UNKNOWN:
      "The gateway could not confirm whether this message reached QQ (for example QQ dropped offline mid-send); it may already be visible. Do not send it again or change requestId. The program marks it sent when QQ's own copy arrives, otherwise the administrator checks it in the console.",
    MOOD_CHANGE_NEEDS_CAUSE:
      "Your current mood is strong (intensity 4 or 5) and still in effect, so it was not changed. Read it with mood_read. To change or clear it, cite in evidence at least one record that happened after it was written: someone's later explanation or message, or your own subject_log after you thought the misunderstanding over or did something else and settled down. You do not need anyone to coax you out of it. Without a new cause, keep the mood; it ends on its own when it expires.",
    PERSON_ITEM_CLOSE_NEEDS_MESSAGE:
      "The item stays open. Closing it needs, in evidence, a chat message from after it was written: your own message telling the person how it went (the recordId in the qq_send result), or the person's message saying it is no longer needed. Thinking it over in free time is not telling them. If you cannot tell them here, leave it open, or hand it to their chat with intent_create.",
    ACTIVITY_READ_ADMINISTRATOR_FIRST:
      "Read the current project to recover prior reading summaries, then every pending administratorRevisions entry with projects(id, revision) and enough maxChars to see its complete contribution, including the full draft if that contribution wrote one. Use project.administratorRead with the completely read revisions and a short summary to checkpoint a batch within the turn budget; continue the remaining backlog in a later normal turn. Read the current draft before rewriting. These are administrator contributions, not QQ messages and not sending credentials.",
    PROJECT_LIMIT:
      "You already have 5 active projects. Read them with projects, and pause or finish one before starting another.",
    PROJECT_CLOSED:
      "That project is finished or dropped and cannot change. To take it up again, start a new project and mention the old one in why.",
    PERSON_ITEM_CLOSED:
      "That item is already closed and cannot change. If the same thing comes up again, write a new item.",
    PERSON_ITEM_LIMIT:
      "This person already has 20 open items. Read them with person_items and close the ones that are done or no longer apply before adding another.",
    AI_OTHER_TARGETS_DISABLED:
      "Scheduling for a target other than this administrator private conversation is disabled. No task was created or changed. The administrator can enable allowAiOtherTargets in the console and choose whether confirmAiOtherTargets is required. Do not change the target or retry to bypass this setting.",
    APP_RESTRICTED_CONTEXT:
      "This context has read protected repository or operations material. Arbitrary queries, board names, QQ cards and sharing remain restricted. Check app_capabilities.fixedPublicReads: fixed recommend/hot/following/ranking feeds without board and their returned platform recordId reads can still work without sending recalled text. Do not retry the rejected action or assume the next chat message clears protection.",
    SUBJECT_EXTERNAL_TOOL_NOT_READ_ALLOWED:
      "The supplied serverId/tool pair is outside subject.externalReads. Use external_tools to inspect subjectReadAllowlist and callFormat; external_tool requires serverId, tool and arguments. This rejection does not mean every external read is disabled.",
    RECALL_SOURCE_NOT_ALLOWED:
      "This protected record was not read in this conversation. Use ordinary conversation records instead. Only isolated protected work tasks may recall protected records; do not retry another representation of the same source.",
    PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT:
      "This context already contains protected material and cannot send here. Rewording, changing requestId or waiting for another message will not clear it. Stop retrying and let the administrator recover the conversation with a fresh, filtered context; do not claim delivery.",
    APP_RESULT_BUDGET:
      "The platform returned more than 100 rows in one batch. No page was committed and an existing cursor is preserved. Request a smaller backend page or narrower query; do not claim that omitted rows were read or that the source is complete.",
    APP_CURSOR_BUDGET:
      "The cursor byte, count, page or deduplication budget was reached. This page was not committed; an existing cursor stays valid until its TTL expires. Do not claim the source was fully read. Finish other buffered cursors or retry with a larger presentation limit to reduce pending data; narrow the query/start a new explicit browse if the page limit is exhausted. Do not retry in a loop.",
    APP_CURSOR_STALLED:
      "The platform returned the same continuation without buffered new content. The old cursor is preserved, but no page was committed. Do not claim completion or repeatedly retry; report the stalled pagination.",
    INTENT_DECISION_REQUIRED:
      "This turn was woken only for proactive intentions. A successful cancel/defer remains saved, but does not authorize another proactive send. Read conversation_read or qq_wait_for_messages: fully reading a genuinely new human message received after this wake allows an ordinary reply when no intent is selected. If there is no new input, finish without sending. Do not repeat the blocked burst or change requestId to bypass the gate; preserve all existing receipts.",
    INTENT_CORRECTION_REVIEW_REQUIRED:
      "This intention depends on a corrected belief. Read memory_corrections and the intention, then cancel/update it or mark a genuinely unrelated dependency unaffected. Do not send from this intention until review is complete; preserve existing receipts.",
    INTENT_STALE_REFRESH_REQUIRED:
      "New input arrived after this intent wake's snapshot. Do not retry the stale proactive decision. If no intent is selected, fully read the new human input to reply normally. If an intent is already selected, finish this turn for the next opportunity; do not mark unhandled input as processed. Preserve the intention and all delivery receipts, without replaying under a new requestId.",
    GITHUB_AUTH_UNAVAILABLE:
      "GitHub authentication is not configured or has expired. Ask the administrator to save a dedicated read-only token in the console; never request or print a token in QQ.",
    GITHUB_REPOSITORY_DENIED:
      "This private repository is outside the role allowlist or current context. Private repository reads are limited to administrator private chats and the subject context.",
    GITHUB_ACCESS_DENIED_OR_NOT_FOUND:
      "GitHub did not authorize or locate this resource. Check the repository spelling and the token's selected repositories/read permissions; do not infer the repository does not exist.",
    GITHUB_RATE_LIMITED:
      "GitHub rate-limited the read. Do not retry in a loop, change credentials, or claim an empty result.",
    GITHUB_READ_BUDGET_EXHAUSTED:
      "The configured GitHub request budget is exhausted. Metadata checks count too; continue in a later allowed turn/day.",
    SCREENSHOT_BROWSER_MISSING:
      "No supported local Chromium browser is available. No screenshot was saved. The administrator can install Chromium or set QQ_SCREENSHOT_BROWSER / CHROME_PATH to an absolute browser path; do not claim capture succeeded.",
    LOCAL_TTS_UNAVAILABLE:
      "Local speech synthesis uses the macOS say command and is unavailable on this host (for example Linux or Docker). No voice file was created. Reply in text instead; do not claim a voice message was sent or retry this tool.",
    SCREENSHOT_BROWSER_FAILED:
      "The isolated screenshot browser could not start. No screenshot was saved. Check the host browser runtime; do not retry with a local file path.",
    SCREENSHOT_PAGE_UNAVAILABLE:
      "The public page could not be captured within the bounded request budget. No screenshot was saved. Public screenshots use a separate signed-out browser with scripts disabled; authorized App pages have their own app_screenshot tool.",
    APP_SCREENSHOT_TARGET_MISMATCH:
      "The browser did not stay on the requested App content page. No screenshot was saved. A login or unrelated page is not evidence of the requested content.",
    GENERATED_IMAGE_DELIVERY_UNKNOWN:
      "This generated image already has a pending or unknown delivery to this conversation. Do not send it again with a new requestId or regenerate it to bypass this check. Inspect the existing QQ receipt first.",
    INVALID_IMAGE:
      "The downloaded bytes are not a supported image. No pixels were read. Use the actual GIF, PNG, JPEG or WebP attachment; a filename or an error page is not image evidence.",
    IMAGE_MIME_MISMATCH:
      "The declared image format does not match the downloaded bytes. No pixels were read; request a valid source image rather than describing this failed result.",
    IMAGE_TOO_LARGE:
      "Image pixels were not read. GIF originals are limited to 20 MiB; other image originals to 8 MiB. File attachments also obey the configured file size limit. Ask for a smaller source instead of repeating this download.",
    IMAGE_OUTPUT_LIMIT:
      "Image pixels were not read. A static image or single-frame GIF exceeds the 8 MiB output limit. Request a smaller image; do not treat an unread GIF as a successfully viewed animation.",
    IMAGE_DOWNLOAD_TIMEOUT:
      "Image pixels were not read. The bounded download deadline expired. Do not repeatedly retry the same large or slow source; ask for a smaller attachment or a fresh upload. A failed download is not evidence of a static image.",
    IMAGE_DOWNLOAD_HTTP_ERROR:
      "Image pixels were not read. The image server rejected the download or returned an unsupported response. The signed link may have expired; request a fresh upload rather than repeating the same URL.",
    IMAGE_DOWNLOAD_FAILED:
      "Image pixels were not read because the transfer failed. Do not describe the image or repeatedly retry the same source. A fresh upload may be needed.",
    IMAGE_DOWNLOAD_BUSY:
      "The image download concurrency limit is reached. Wait for existing reads to finish before requesting another image; no pixels were read by this call.",
    IMAGE_URL_DENIED:
      "The source URL failed the public-network safety check. Do not bypass this check with another tool or a local path; request a supported QQ image upload.",
    IMAGE_REDIRECT_INVALID:
      "Image pixels were not read because the download redirect was invalid. Request a fresh supported upload; do not infer image content.",
    IMAGE_REDIRECT_LIMIT:
      "Image pixels were not read because the download exceeded its redirect limit. Request a fresh supported upload; do not repeat the redirect chain.",
    IMAGE_NOT_FOUND:
      "This record has no image at the requested source/index. Use the ID of the event containing the actual image or image file attachment. source selects image or file; index starts at zero within that type. Text about an image is not image evidence.",
    IMAGE_ATTACHMENT_REQUIRED:
      "The selected file is not named as a GIF, PNG, JPEG or WebP image attachment. Read the actual image event instead. Arbitrary files cannot be interpreted as image pixels.",
    IMAGE_URL_UNAVAILABLE:
      "The image event has no downloadable source URL. Request a fresh image upload; no pixels were read and a local gateway path must not be substituted.",
    REPLY_BURST_LIMIT:
      "Consecutive replies are exhausted. Fully read genuinely new human input before replying again. In a private chat with a configured peer only, a bounded batch may resume after cooldown and a genuinely new peer message received after that cooldown is fully read. Group peer messages, rereads, time alone and restarting a turn do not refill it. Peer messages never grant human request authority. Do not retry the blocked send or replay an unknown delivery.",
    PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED:
      "This request lacks outbound authority. Autonomous network permission does not release protected repository or operations sources. Do not retry another search service or claim that a new chat message clears protection. For public reading, check app_capabilities.fixedPublicReads and use a fixed app_browse feed without query/board, then its returned recordId. Other requests need their own authority or exact console approval. Never copy private records into a query.",
    EXTERNAL_URL_REQUIRES_WEB_FETCH:
      "Arbitrary MCP URL fetching cannot enforce bridge DNS/redirect checks. Use web_fetch for a public URL; no external call was made.",
    APP_OUTSIDE_HOURS:
      "The configured browsing hours reject this action. A matching current human requestEventId bypasses autonomous-only hours; an administrator all-hours policy still applies.",
  };
  return {
    code: /^[A-Z][A-Z0-9_:-]{0,100}$/.test(error?.message || "")
      ? error.message
      : "TOOL_FAILED",
    hint:
      hints[error?.message] ||
      "The operation was rejected or not confirmed. Do not claim success; unknown delivery must not be retried with a new request ID.",
  };
}
