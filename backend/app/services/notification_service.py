import logging

logger = logging.getLogger("compass.notifications")

async def send_session_reminder(email: str, chw_name: str, session_time: str):
    logger.info(f"[STUB] Session reminder to {email}: session with {chw_name} at {session_time}")

async def send_match_notification(email: str, member_name: str, request_summary: str):
    logger.info(f"[STUB] Match notification to {email}: new request from {member_name}")

async def send_credential_expiry_warning(email: str, credential_type: str, expiry_date: str):
    logger.info(f"[STUB] Credential expiry warning to {email}: {credential_type} expires {expiry_date}")
