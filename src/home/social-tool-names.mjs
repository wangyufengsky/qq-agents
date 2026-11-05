// @ts-check
export const SOCIAL_CORE_TOOLS = Object.freeze([
  "home_social_capabilities",
  "home_visit_invite",
  "home_visit_inbox",
  "home_visit_invitation_read",
  "home_visit_decide",
  "home_visit_read",
  "home_visit_mark_read",
  "home_visit_send",
  "home_visit_end",
  "home_visit_retract",
  "home_visit_room_read",
  "home_visit_grant_reduce",
  "home_social_block",
  "home_social_operation_read",
]);
export const SOCIAL_EXCHANGE_TOOLS = Object.freeze([
  "home_exchange_propose",
  "home_exchange_decide",
  "home_exchange_status",
  "home_exchange_yield",
  "home_exchange_close",
]);
export const SOCIAL_TOOLS = Object.freeze([
  ...SOCIAL_CORE_TOOLS,
  "home_social_process",
  ...SOCIAL_EXCHANGE_TOOLS,
]);
