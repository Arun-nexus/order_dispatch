"""
daily_notifier.py
==================
Runs once a day (triggered by Google Cloud Scheduler -> Cloud Run).
Pulls every pending row from MongoDB and sends ONE message per row using a
single, fixed template (edit MESSAGE_TEMPLATE below — it is used everywhere,
nothing else in this file needs to change when you update it).

Rows covered:
  - orders          where status in ("placed", "processing")
  - services        where status in ("active", "in_progress")
  - allocations     where allocation_type="demo_unit" and return_status="pending"
  - allocations     where allocation_type="spare_part" and return_status="pending"
  - accounts        where credit_used >= credit_limit (payment due)

--------------------------------------------------------------------------
DEPLOY (Cloud Run — Always Free tier, no Docker file needed, gcloud builds
it for you from requirements.txt):
--------------------------------------------------------------------------
gcloud run deploy daily-notifier \
  --source . \
  --region asia-south1 \
  --no-allow-unauthenticated \
  --set-env-vars SMTP_USER=you@gmail.com,SMTP_PASSWORD=your_app_password,TWILIO_SID=...,TWILIO_AUTH_TOKEN=...,TWILIO_SMS_FROM=...,TWILIO_WHATSAPP_FROM=...

This prints a Service URL like:
  https://daily-notifier-xxxxx-el.a.run.app

--------------------------------------------------------------------------
SCHEDULE (Cloud Scheduler) — run once, calls the service every day at 9 AM IST:
--------------------------------------------------------------------------
# 1) create a service account Cloud Scheduler will authenticate as, and let it invoke this service
gcloud iam service-accounts create scheduler-invoker
gcloud run services add-iam-policy-binding daily-notifier \
  --region asia-south1 \
  --member="serviceAccount:scheduler-invoker@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 2) create the daily job
gcloud scheduler jobs create http daily-notifier-job \
  --schedule="0 9 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="https://daily-notifier-xxxxx-el.a.run.app" \
  --http-method=POST \
  --oidc-service-account-email=scheduler-invoker@<PROJECT_ID>.iam.gserviceaccount.com
--------------------------------------------------------------------------
Local test: `python daily_notifier.py` then `curl -X POST http://localhost:8080/`
--------------------------------------------------------------------------
"""

import os
import smtplib
from email.mime.text import MIMEText

from flask import Flask, jsonify

from configuration import load_params
from mongodb.mongodb_connection import mongodbclient
from logger import logging

app = Flask(__name__)

params = load_params()
ACCOUNTS_COLLECTION = params["account_creation_collection_name"]
ORDERS_COLLECTION = params["order_collection_name"]
SERVICE_COLLECTION = params["service_collection_name"]
ALLOCATION_COLLECTION = params.get("allocation_collection_name", "allocations")

# ---------------------------------------------------------------------------
# THE template — edit this block only. {type} and {detail} get filled in
# per row; everything else in the file reuses this exact string as-is.
# ---------------------------------------------------------------------------
MESSAGE_TEMPLATE = "Reminder: {type} pending — {detail}. Please take action at the earliest."

# ---------------------------------------------------------------------------
# Provider credentials — set these as env vars wherever this runs
# ---------------------------------------------------------------------------
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", SMTP_USER)

TWILIO_SID = os.getenv("TWILIO_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_SMS_FROM = os.getenv("TWILIO_SMS_FROM", "")
TWILIO_WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "")


# ---------------------------------------------------------------------------
# Pull every pending row from Mongo
# ---------------------------------------------------------------------------
def get_pending_rows():
    db = mongodbclient()

    orders = db.get_data(ORDERS_COLLECTION, query={"status": {"$in": ["placed", "processing"]}})
    services = db.get_data(SERVICE_COLLECTION, query={"status": {"$in": ["active", "in_progress"]}})
    demo_units = db.get_data(ALLOCATION_COLLECTION, query={"allocation_type": "demo_unit", "return_status": "pending"})
    spare_parts = db.get_data(ALLOCATION_COLLECTION, query={"allocation_type": "spare_part", "return_status": "pending"})
    accounts = db.get_data(ACCOUNTS_COLLECTION, query={})
    credit_due = [a for a in accounts if (a.get("credit_used", 0) or 0) >= (a.get("credit_limit", 0) or 0) > 0]

    rows = []
    for o in orders:
        rows.append({
            "type": "Order", "detail": f"Order #{o.get('order_id', '')[:8]} for {o.get('customer', {}).get('company_name', '')}",
            "recipient": o.get("customer", {})
        })
    for s in services:
        rows.append({
            "type": "Service", "detail": f"Service #{s.get('service_id', '')[:8]} — {s.get('issue', '')}",
            "recipient": {"username": s.get("technician_alloted")}
        })
    for d in demo_units:
        rows.append({
            "type": "Demo Unit Held", "detail": f"Allocation #{d.get('allocation_id', '')[:8]} with {d.get('distributor', {}).get('company_name', '')}",
            "recipient": d.get("distributor", {})
        })
    for sp in spare_parts:
        rows.append({
            "type": "Spare Part Held", "detail": f"Allocation #{sp.get('allocation_id', '')[:8]} — {sp.get('spare_part', {}).get('part_name', '')}",
            "recipient": sp.get("distributor", {})
        })
    for c in credit_due:
        rows.append({
            "type": "Payment Due", "detail": f"{c.get('name', c.get('username'))} — ₹{c.get('credit_used', 0)} used of ₹{c.get('credit_limit', 0)} limit",
            "recipient": c
        })

    return rows


# ---------------------------------------------------------------------------
# Senders — fill in real provider calls
# ---------------------------------------------------------------------------
def send_email(to_email, text_body):
    if not to_email or not SMTP_PASSWORD:
        logging.info(f"[email skipped] no address or SMTP not configured for {to_email}")
        return
    msg = MIMEText(text_body, "plain")
    msg["Subject"] = "Acer Biomedical — Pending Item Reminder"
    msg["From"] = EMAIL_FROM
    msg["To"] = to_email
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(EMAIL_FROM, [to_email], msg.as_string())
        logging.info(f"email sent to {to_email}")
    except Exception as e:
        logging.error(f"email send failed for {to_email}: {e}")


def send_sms(to_number, text_body):
    if not to_number or not TWILIO_SID:
        logging.info(f"[sms skipped] no number or Twilio not configured for {to_number}")
        return
    # TODO: pip install twilio, then uncomment:
    # from twilio.rest import Client
    # Client(TWILIO_SID, TWILIO_AUTH_TOKEN).messages.create(body=text_body, from_=TWILIO_SMS_FROM, to=f"+91{to_number}")
    logging.info(f"sms send stubbed for {to_number}")


def send_whatsapp(to_number, text_body):
    if not to_number or not TWILIO_SID:
        logging.info(f"[whatsapp skipped] no number or Twilio not configured for {to_number}")
        return
    # TODO: pip install twilio, then uncomment:
    # from twilio.rest import Client
    # Client(TWILIO_SID, TWILIO_AUTH_TOKEN).messages.create(body=text_body, from_=TWILIO_WHATSAPP_FROM, to=f"whatsapp:+91{to_number}")
    logging.info(f"whatsapp send stubbed for {to_number}")


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------
def run_daily_notify():
    rows = get_pending_rows()
    sent = 0
    for row in rows:
        text_body = MESSAGE_TEMPLATE.format(type=row["type"], detail=row["detail"])
        recipient = row.get("recipient") or {}
        send_email(recipient.get("email"), text_body)
        send_sms(recipient.get("phone") or recipient.get("contact_number"), text_body)
        send_whatsapp(recipient.get("phone") or recipient.get("contact_number"), text_body)
        sent += 1

    logging.info(f"daily notify run complete — {sent} rows processed")
    return {"message": "daily notify complete", "rows_processed": sent}


@app.route("/", methods=["POST", "GET"])
def handle_trigger():
    # Cloud Scheduler sends POST; GET is here only so you can hit the URL in
    # a browser to test manually.
    try:
        result = run_daily_notify()
        return jsonify(result), 200
    except Exception as e:
        logging.error(f"daily notify run failed: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))