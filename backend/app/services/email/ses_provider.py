"""AWS SES email provider.

SES is the right default for us because:
  - AWS BAA already covers SES for healthcare
  - No additional vendor BAA needed
  - Pay-per-email at $0.10/1000 — cheapest option for MVP scale

Requires IAM role or credentials with `ses:SendEmail` permission.
Sender domain (joincompasschw.com) must be verified in SES console and have
DKIM set up.
"""

import asyncio
import logging

from app.services.email.base import EmailMessage, EmailProvider, EmailResult

logger = logging.getLogger("compass.email.ses")


class SESEmailProvider(EmailProvider):
    def __init__(
        self,
        region: str,
        from_address: str,
        reply_to: str | None = None,
    ) -> None:
        self._region = region
        self._from_address = from_address
        self._reply_to = reply_to
        self._client = None

    def _get_client(self):
        """Lazy-initialize the boto3 SES client so we don't import boto3 when unused."""
        if self._client is None:
            try:
                import boto3
                self._client = boto3.client("ses", region_name=self._region)
            except ImportError:
                logger.error("boto3 not installed — cannot send email")
                return None
        return self._client

    async def send(self, message: EmailMessage) -> EmailResult:
        client = self._get_client()
        if client is None:
            return EmailResult(success=False, error="boto3 not available")

        # boto3 is sync — run in a thread to avoid blocking the event loop
        def _send_sync() -> EmailResult:
            try:
                response = client.send_email(
                    Source=self._from_address,
                    Destination={"ToAddresses": [message.to]},
                    Message={
                        "Subject": {"Data": message.subject, "Charset": "UTF-8"},
                        "Body": {
                            "Html": {"Data": message.html, "Charset": "UTF-8"},
                            "Text": {"Data": message.text, "Charset": "UTF-8"},
                        },
                    },
                    ReplyToAddresses=[self._reply_to] if self._reply_to else [],
                    Tags=[{"Name": k, "Value": v} for k, v in message.tags.items()],
                )
                return EmailResult(
                    success=True,
                    provider_message_id=response.get("MessageId"),
                )
            except Exception as e:  # noqa: BLE001
                logger.error("SES send failed: %s", e)
                return EmailResult(success=False, error=str(e))

        return await asyncio.to_thread(_send_sync)
