from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from bson import ObjectId
from logger import logging
from configuration import load_params
from dotenv import load_dotenv
from mongodb.mongodb_connection import mongodbclient
from user.company import login
from order.manage_order import order_manager
from service.service_details import service_detail, GDRIVE_PLACEHOLDER
from gdrive_media import upload_base64_to_drive
from inventory.inventory_handling import inventory_manager
from user.customer_details import customer_manager
from sales.sales_person_manager import sales_person_manager
from allocation.allocation import allocation_manager
from request.request_manager import request_manager
from shipment.manage_shipment import shipment_manager
from assembly.manage_assembly import assembly_manager
from auth import create_access_token, get_current_user, require_role
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import os
import re
import uuid
import base64
import smtplib
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
import io
import time
import threading
from html.parser import HTMLParser
try:
    from twilio.rest import Client as TwilioClient  
except ImportError:
    TwilioClient = None


def compute_warranty_until(received_date: str, warranty_text: str):
    """
    Parses a free-text warranty duration like "12 months", "1 year", "30 days"
    (as entered on the shipment product) and adds it to received_date
    (YYYY-MM-DD) to get the warranty expiry date. Returns an ISO date string
    (YYYY-MM-DD), or None if either input can't be parsed.
    """
    if not received_date or not warranty_text:
        return None
    match = re.search(r"(\d+)\s*(day|month|year)", warranty_text.strip().lower())
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2)
    try:
        base = datetime.strptime(received_date, "%Y-%m-%d")
    except ValueError:
        return None

    if unit == "day":
        result = base + timedelta(days=amount)
    elif unit == "year":
        result = base.replace(year=base.year + amount)
    else:  # month
        total_months = base.month - 1 + amount
        year = base.year + total_months // 12
        month = total_months % 12 + 1
        days_in_month = [31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28,
                          31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        day = min(base.day, days_in_month[month - 1])
        result = base.replace(year=year, month=month, day=day)

    return result.strftime("%Y-%m-%d")

load_dotenv()
app = FastAPI()
params = load_params()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# resolve everything relative to THIS file's own folder, not whatever
# directory uvicorn happens to be launched from
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ACCOUNTS_COLLECTION = params["account_creation_collection_name"]
ORDERS_COLLECTION = params["order_collection_name"]
SERVICE_COLLECTION = params["service_collection_name"]
INVENTORY_COLLECTION = params["inventory_collection_name"]
CUSTOMER_COLLECTION = params.get("customer_collection_name", "customers")
SALESPERSON_COLLECTION = params.get("salesperson_collection_name", "sales_persons")
ALLOCATION_COLLECTION = params.get("allocation_collection_name", "allocations")
REQUESTS_COLLECTION = params.get("requests_collection_name", "requests")
SHIPMENT_COLLECTION = params.get("shipment_collection_name", "shipments")
ASSEMBLY_COLLECTION = params.get("assembly_collection_name", "assemblies")
ATTENDANCE_COLLECTION = params.get("attendance_collection_name", "attendance")
ATTENDANCE_SETTINGS_COLLECTION = params.get("attendance_settings_collection_name", "attendance_settings")

# ---- Damaged-product report settings ----
# Image is emailed out immediately when reported, then wiped from Mongo after
# DAMAGE_IMAGE_RETENTION_DAYS to keep the database light. The issue text and
# who/when metadata are kept forever - only the (large) base64 image is purged.
DAMAGE_IMAGE_RETENTION_DAYS = int(os.getenv("DAMAGE_IMAGE_RETENTION_DAYS", "2"))
GMAIL_SENDER_EMAIL = os.getenv("GMAIL_SENDER_EMAIL", "")
GMAIL_SENDER_APP_PASSWORD = os.getenv("GMAIL_SENDER_APP_PASSWORD", "")
GMAIL_NOTIFY_RECEIVER = os.getenv("GMAIL_NOTIFY_RECEIVER", GMAIL_SENDER_EMAIL)


class LoginRequest(BaseModel):
    username: str
    password: str
    role: str


class CreateAccountRequest(BaseModel):
    username: str
    password: str
    confirm_password: str
    name: str
    email_id: str
    gst_number: str
    company_name: str
    mobile_no: str
    role: str
    manager: str = ""
    credit_limit: float = 0


class UpdateAccountRequest(BaseModel):
    updated_values: dict


class ServiceRequest(BaseModel):
    product_id: str
    serial_no: str
    technician_id: str
    purchase_date: str
    issue: str
    image: str
    video: str
    location: str = "indoor"
    spare_parts: str = ""


class OrderItem(BaseModel):
    product_id: str
    product_name: str
    model_no: str = ""
    quantity: int
    price: float
    tax_rate: float = 0
    # manually reviewed/chosen serial numbers, one per unit, in order — when
    # given (must have exactly `quantity` entries), these exact serials are
    # deducted instead of auto-allocating oldest-lot-first. Left empty (the
    # default) to keep the old fully-automatic behavior.
    serial_numbers: list[str] = []


class CreateOrderRequest(BaseModel):
    customer_id: str = ""          # set when an existing customer was picked
    customer: dict = {}            # denormalized snapshot: company_name, company_address,
                                    # gst_number, contractor_person, contractor_number, contractor_email
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}     # credit_days / cheque_number+cheque_date / dd_number+dd_date etc.
    discount: float = 0
    warranty_years: int = 1        # standard warranty is 1 year; > 1 means extended
    warranty_charge: float = 0     # additional charge for the extended warranty (0 for standard)


class CustomerRequest(BaseModel):
    company_name: str
    company_address: str = ""
    gst_number: str = ""
    contractor_person: str = ""
    contractor_number: str = ""
    contractor_email: str = ""
    credit_limit: float = 0


class CustomerUpdateRequest(BaseModel):
    updated_values: dict


class SalesPersonRequest(BaseModel):
    name: str
    company_name: str = ""
    address: str = ""
    contact_number: str = ""
    email: str = ""


class AllocationItem(BaseModel):
    product_id: str
    product_name: str
    quantity: int
    model_no: str = ""
    serial_numbers: list[str] = []


class SparePartAllocation(BaseModel):
    service_id: str
    part_name: str
    quantity: int = 1


class CreateAllocationRequest(BaseModel):
    allocated_to: str = ""  # username of a registered system user
    items: list[AllocationItem] = []
    spare_part: SparePartAllocation | None = None
    company_name: str = ""
    address: str = ""
    gst_number: str = ""
    phone_number: str = ""


class CreateDemoUnitRequest(BaseModel):
    customer_id: str = ""
    customer: dict = {}
    items: list[AllocationItem]


class OrderStatusRequest(BaseModel):
    order_id: str


class LateThresholdRequest(BaseModel):
    late_time: str  # "HH:MM", 24-hour format — anyone clocking in after this is marked late


class DispatchConfirmRequest(BaseModel):
    docket_no: Optional[str] = None
    invoice_no: str
    invoice_date: str
    mode_of_delivery: Optional[str] = None
    ship_to_different: bool = False
    ship_to_address: Optional[dict]= None   # {company_name, address} — only used when ship_to_different is True
    image: Optional[str] = None   # optional base64 data URI, e.g. packaging/handover photo


class ServicePartUsed(BaseModel):
    part_name: str
    old_hologram_number: str
    new_hologram_number: str


class ServiceUpdateRequest(BaseModel):
    service_status: str
    reason: str = ""
    image: Optional[str] = None
    video: Optional[str] = None
    spare_parts_used: bool = False
    spare_parts: str = ""
    service_charges: Optional[float] = None
    parts_used: list[ServicePartUsed] = []


class ServiceChargeRequest(BaseModel):
    service_charges: float


class ServiceMediaRequest(BaseModel):
    image: Optional[str] = None
    video: Optional[str] = None


class SparePartRequest(BaseModel):
    note: str


class ExtendWarrantyRequest(BaseModel):
    warranty_until: str


class OrderUpdatedValue(BaseModel):
    updated_order_value: dict


class InventoryRequest(BaseModel):
    product_name: str
    product_id: str
    quantity: int
    purchase_date: str
    lot_no: str
    supplier: str
    price: str
    tax_rate: int
    model_no: str = ""
    supplier_address: str = ""
    serial_numbers: list[str] = []
    product_type: str = "product"  # "product" | "spare_parts" | "service_parts" | "damaged" | "accessories"
    parent_product_name: str = ""     # spare_parts / service_parts: which product the part belongs to
    part_category: str = ""           # service_parts: "purchase" | "warranty"
    warranty_until: str = ""          # YYYY-MM-DD, parts + damaged
    reason: str = ""                  # damaged: reason of damage
    hologram_numbers: list[str] = []  # spare_parts / service_parts, optional, one per unit


class InventoryUpdateRequest(BaseModel):
    updated_values: dict
    new_serial_numbers: list[str] = []
    remove_serial_numbers: list[str] = []
    faulty_serial_numbers: list[str] = []     # pulled off this lot and pushed into the "damaged" category instead of just discarded
    new_hologram_numbers: list[str] = []      # serial-wise hologram numbers to add (spare_parts / service_parts only)
    remove_hologram_numbers: list[str] = []
    model_no: Optional[str] = None   # disambiguates which lot-document to touch when a product_id has multiple model_no variants


class ShipmentPart(BaseModel):
    part_name: str
    quantity: int = 0
    status: str = "assembly"      # "assembly" (-> inventory spare_parts) | "purchase" | "warranty" (both -> inventory service_parts)


class ShipmentProduct(BaseModel):
    product_name: str
    quantity: int = 0
    price: float = 0
    warranty: str = ""            # e.g. "12 months" - optional
    parts: list[ShipmentPart] = []


class CreateShipmentRequest(BaseModel):
    company_name: str
    company_address: str = ""
    dispatch_date: str
    received_date: str = ""       # optional - can be added later via mark_received
    products: list[ShipmentProduct]


class ShipmentReceivedRequest(BaseModel):
    received_date: str


class ShipmentUpdateRequest(BaseModel):
    updated_values: dict


class AssemblyPartUsed(BaseModel):
    part_name: str
    quantity: int = 0
    source: str = "inventory"     # "inventory" (deduct from inventory's spare_parts stock) | "local" (sourced outside, no deduction)


class AssemblySerialItem(BaseModel):
    serial_number: str


class CreateAssemblyRequest(BaseModel):
    product_name: str
    product_id: str = ""
    model_number: str = ""
    quantity: int
    parts_used: list[AssemblyPartUsed] = []
    serials: list[AssemblySerialItem]


class AssemblyUpdateRequest(BaseModel):
    updated_values: dict


@app.get("/")
def home():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/main_dashboard.html")
def dashboard():
    return FileResponse(os.path.join(BASE_DIR, "main_dashboard.html"))


@app.post("/login/")
def login_page(request: LoginRequest):
    try:
        db = login()
        dataset = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if not dataset:
            raise HTTPException(
                status_code=404,
                detail="username was not registered! please create account before login."
            )

        user = dataset[0]

        if user["password"] != request.password or user["role"] != request.role:
            raise HTTPException(status_code=401, detail="details did not match")

        token = create_access_token(username=user["username"], role=user["role"])

        return {
            "message": "access granted",
            "role": user["role"],
            "access_token": token,
            "token_type": "bearer"
        }

    except HTTPException:
        raise
    except Exception as e:
        logging.error("login was not successful")
        raise HTTPException(status_code=500, detail="login failed")


@app.get("/account/")
def account(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        logging.info("account dataset was fetched successfully")
        return {"message": "account dataset", "dataset": dataset}
    except Exception as e:
        logging.error("account dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="account informations cannot be fetched")


@app.get("/account/my_team")
def my_team(user: dict = Depends(require_role("distributor"))):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION,
                               query={"role": "distributor", "manager": user["username"]})
        team = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        return {"message": "my team", "dataset": team}
    except Exception as e:
        logging.error("fetching team list failed")
        raise HTTPException(status_code=500, detail="team list cannot be fetched")


@app.get("/allocation/team")
def team_allocations(user: dict = Depends(require_role("distributor"))):
    try:
        acc_db = mongodbclient()
        team = acc_db.get_data(collection_name=ACCOUNTS_COLLECTION,
                                query={"role": "distributor", "manager": user["username"]})
        team_usernames = [t["username"] for t in team]
        if not team_usernames:
            return {"message": "no team members", "dataset": []}

        alloc_db = allocation_manager()
        dataset = alloc_db.get_data(collection_name=ALLOCATION_COLLECTION,
                                     query={"allocation_type": "demo_unit", "allocated_by": {"$in": team_usernames}},
                                     projection={"damage_report.image": 0})
        return {"message": "team demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching team allocations failed")
        raise HTTPException(status_code=500, detail="team allocations cannot be fetched")


@app.get("/account/technicians")
def list_technicians(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"role": "technician"})
        technicians = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        logging.info("technician list was fetched successfully")
        return {"message": "technician list", "dataset": technicians}
    except Exception as e:
        logging.error("technician list cannot be fetched")
        raise HTTPException(status_code=500, detail="technician list cannot be fetched")


@app.get("/account/distributors")
def list_distributors(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"role": "distributor"})
        distributors = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        logging.info("distributor list was fetched successfully")
        return {"message": "distributor list", "dataset": distributors}
    except Exception as e:
        logging.error("distributor list cannot be fetched")
        raise HTTPException(status_code=500, detail="distributor list cannot be fetched")


@app.get("/account/users")
def list_system_users(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    """Safe (no password) list of every system user, used by the allocation wizard."""
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        users = [
            {"username": a.get("username"), "name": a.get("name") or a.get("username"), "role": a.get("role"),
             "contact_number": a.get("phone", ""), "email": a.get("email", ""), "company_name": a.get("company_name", "")}
            for a in dataset
        ]
        return {"message": "system users", "dataset": users}
    except Exception:
        logging.error("system users cannot be fetched")
        raise HTTPException(status_code=500, detail="users cannot be fetched")


@app.post("/account/create_account/")
def create_account(request: CreateAccountRequest, user: dict = Depends(require_role("admin"))):
    try:
        if request.password != request.confirm_password:
            raise HTTPException(status_code=400, detail="confirm password is not same as password")

        if len(request.mobile_no) != 10 or not request.mobile_no.isdigit():
            raise HTTPException(status_code=400, detail="make sure mobile no is valid")

        db = login()
        existing_user = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if existing_user:
            raise HTTPException(status_code=409, detail="username was already registered please try a different username")

        if request.role == "distributor" and request.manager:
            manager_exists = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.manager, "role": "distributor"})
            if not manager_exists:
                raise HTTPException(status_code=400, detail="selected manager was not found among distributor accounts")

        new_user = login(
            username=request.username,
            name=request.name,
            phone=request.mobile_no,
            email=request.email_id,
            company_name=request.company_name,
            gst_number=request.gst_number,
            role=request.role,
            password=request.password
        )
        new_user.add(collection_name=ACCOUNTS_COLLECTION)

        db.update_data(collection_name=ACCOUNTS_COLLECTION, query={"username": request.username},
                        update_values={"credit_limit": request.credit_limit, "credit_used": 0})

        if request.role == "distributor" and request.manager:
            db.update_data(collection_name=ACCOUNTS_COLLECTION, query={"username": request.username},
                            update_values={"manager": request.manager})

        logging.info("account creation was successful")
        return {"message": "account creation was successful"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("account creation was failed!")
        raise HTTPException(status_code=500, detail="account creation failed")


@app.post("/login/delete_account/{username}")
def delete_account(username: str, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.delete(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
        logging.info("account deleted successfully")
        return {"message": "account was deleted successfully", "username": username}

    except Exception as e:
        logging.error("account cannot be deleted.")
        raise HTTPException(status_code=500, detail="account cannot be deleted")


@app.post("/login/update_account/{username}")
def update_account(username: str, updated_values: UpdateAccountRequest, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.update(collection_name=ACCOUNTS_COLLECTION, query={"username": username},
                        update_values=updated_values.updated_values)
        logging.info("account values are updated")
        return {"message": "account details was updated", "username": username,
                "updated_value": updated_values.updated_values}
    except Exception as e:
        logging.error("account details updation was failed")
        raise HTTPException(status_code=500, detail="account details updation was unsuccessful")


VALID_PAYMENT_MODES = {"Credit", "NetBanking", "UPI", "Cheque", "DemandDraft", "Cash"}


def _raise_media_review_request(service_id: str, raised_by: str):
    """Creates a 'media_review' request so admin/accounts get a bell notification
    to download the uploaded video. Approving it confirms the download and clears
    the video from the database; rejecting it discards the video without keeping it."""
    try:
        req = request_manager(
            request_type="media_review",
            raised_by=raised_by,
            details={"service_id": service_id, "kind": "video"}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
    except Exception:
        logging.error("could not raise media review notification")


def _damaged_part_warranty(old_hologram: str):
    """Looks up which shipment lot the removed part (identified by its old
    hologram number) came from - i.e. the spare_parts/service_parts
    inventory entry whose hologram_numbers list contains this hologram - and
    returns that lot's warranty_until (or None if the hologram isn't found
    on any lot, or the lot was never covered by a warranty)."""
    inv_db = inventory_manager()
    entries = inv_db.get_data(
        collection_name=INVENTORY_COLLECTION,
        query={"hologram_numbers": old_hologram, "product_type": {"$in": ["spare_parts", "service_parts"]}}
    )
    if not entries:
        return None
    return entries[0].get("warranty_until")


def _swap_faulty_part(service_id: str, parts_used: list):
    """When a service is closed with spare part(s) used: for each part,
    checks the entered old hologram number against the hologram currently
    on file for the product's serial number in the assembly record (a
    mismatch is only a warning, never blocks), rolls the assembly record's
    hologram forward to that part's new hologram number, and adds the
    removed part into inventory as a damaged product (name = part name,
    product_id = its old hologram number).

    Before filing it as damaged, the shipment lot the part originally came
    from (matched via its old hologram number) is looked up so we know
    whether that lot's warranty is still valid:
      - still under warranty -> warranty_until is carried onto the damaged
        entry, so /inventory/'s dynamic warranty_status calc marks it
        "under warranty" (and how many days are left) automatically
      - warranty expired, or no shipment lot/warranty found at all -> marked
        "over warranty", and this service's service_id is recorded in the
        damaged entry's `reason` field for traceability

    Returns True if any part's old hologram number did not match what's on
    file (or couldn't be verified)."""
    svc_db = service_detail()
    svc = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
    if not svc:
        return False
    serial_no = svc[0].get("serial_no")

    assembly = None
    serials = None
    serial_entry = None
    if serial_no:
        asm_db = assembly_manager()
        assemblies = asm_db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"serials.serial_number": serial_no})
        if assemblies:
            assembly = assemblies[0]
            serials = assembly.get("serials", [])
            for s in serials:
                if s.get("serial_number") == serial_no:
                    serial_entry = s
                    break

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    mismatch = False
    for part in parts_used:
        part_name = part.get("part_name")
        old_hologram = part.get("old_hologram_number")
        new_hologram = part.get("new_hologram_number")

        if serial_entry is not None:
            recorded_hologram = serial_entry.get("hologram_number") or ""
            if recorded_hologram and recorded_hologram != old_hologram:
                mismatch = True
            serial_entry["replaced"] = True
            serial_entry["previous_hologram_number"] = old_hologram
            serial_entry["hologram_number"] = new_hologram
        else:
            mismatch = True

        warranty_until = _damaged_part_warranty(old_hologram)
        under_warranty = bool(warranty_until) and warranty_until >= today
        # only when the part is already out of warranty (or its shipment lot
        # couldn't be traced at all) do we stamp the damage reason with this
        # service's service_id - an in-warranty part doesn't need that
        # trail, its warranty_until on the entry already tells the story
        reason = "" if under_warranty else f"damaged part removed during service {service_id}"

        inv_db = inventory_manager(product_name=part_name, product_id=old_hologram,
                                    quantity=1, product_type="damaged",
                                    warranty_until=warranty_until, reason=reason)
        inv_db.add(collection_name=INVENTORY_COLLECTION)

    if assembly is not None and serials is not None:
        asm_db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly["assembly_id"]},
                      update_values={"serials": serials})

    logging.info(f"faulty part(s) swapped for service {service_id}: {len(parts_used)} part(s) processed")
    return mismatch


def _fulfill_order(customer_id: str, customer: dict, items: list, payment_mode: str, payment_details: dict, discount: float, creator: dict = None, warranty_years: int = 1, warranty_charge: float = 0):
    """Validates payment details, resolves/creates the customer, deducts stock + serials,
    and creates the order record. Shared by the direct /order/create_order/ endpoint and by
    /request/approve/{request_id} when a distributor's order request is approved."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product to the order")

    if payment_mode not in VALID_PAYMENT_MODES:
        raise HTTPException(status_code=400, detail="invalid payment mode")

    if payment_mode == "Credit":
        credit_days = payment_details.get("credit_days")
        if not credit_days or not (0 < int(credit_days) <= 60):
            raise HTTPException(status_code=400, detail="credit days must be between 1 and 60")

    if payment_mode == "Cheque" and not payment_details.get("cheque_number"):
        raise HTTPException(status_code=400, detail="cheque number is required")

    if payment_mode == "DemandDraft" and not payment_details.get("dd_number"):
        raise HTTPException(status_code=400, detail="demand draft number is required")

    if payment_mode == "UPI" and not payment_details.get("upi_id"):
        raise HTTPException(status_code=400, detail="UPI ID is required")

    if payment_mode == "NetBanking" and not (
        payment_details.get("bank_name")
        and payment_details.get("account_number")
        and payment_details.get("ifsc_code")
    ):
        raise HTTPException(status_code=400, detail="bank name, account number and IFSC code are required")

    if payment_mode == "Cash" and not payment_details.get("received_by"):
        raise HTTPException(status_code=400, detail="received-by person name is required")

    customer_db = customer_manager()
    customer_snapshot = dict(customer or {})

    if customer_id:
        existing = customer_db.get_data(CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not existing:
            raise HTTPException(status_code=404, detail="selected customer not found")
        customer_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
    else:
        if not customer_snapshot.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        new_customer = customer_manager(
            company_name=customer_snapshot.get("company_name"),
            company_address=customer_snapshot.get("company_address"),
            gst_number=customer_snapshot.get("gst_number"),
            contractor_person=customer_snapshot.get("contractor_person"),
            contractor_number=customer_snapshot.get("contractor_number"),
            contractor_email=customer_snapshot.get("contractor_email"),
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)
        creator_username = (creator or {}).get("raised_by") or (creator or {}).get("username")
        if creator_username:
            customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                     update_values={"created_by": creator_username})
        customer_snapshot = {
            "customer_id": new_customer.customer_id,
            "company_name": new_customer.company_name,
            "company_address": new_customer.company_address,
            "gst_number": new_customer.gst_number,
            "contractor_person": new_customer.contractor_person,
            "contractor_number": new_customer.contractor_number,
            "contractor_email": new_customer.contractor_email,
            "created_by": creator_username,
        }

    inventory_db = inventory_manager()
    qty_by_variant = {}
    for item in items:
        key = (item["product_id"], item.get("model_no") or "")
        qty_by_variant[key] = qty_by_variant.get(key, 0) + item["quantity"]

    for (product_id, model_no), total_qty in qty_by_variant.items():
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, product_id, model_no=model_no or None)
        if available < total_qty:
            sample_name = next((it.get("product_name", product_id) for it in items if it["product_id"] == product_id), product_id)
            variant_note = f" (model {model_no})" if model_no else ""
            raise HTTPException(
                status_code=400,
                detail=f"insufficient stock for {sample_name}{variant_note}: only {available} available"
            )

    order_items = []
    for item in items:
        chosen_serials = item.get("serial_numbers") or []
        if chosen_serials:
            if len(chosen_serials) != item["quantity"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"{item.get('product_name', item['product_id'])}: {len(chosen_serials)} serial number(s) given but quantity is {item['quantity']}"
                )
            if len(set(chosen_serials)) != len(chosen_serials):
                raise HTTPException(status_code=400, detail=f"{item.get('product_name', item['product_id'])}: duplicate serial numbers selected")
            try:
                allocated_serials = inventory_db.allocate_specific_serials(
                    collection_name=INVENTORY_COLLECTION,
                    product_id=item["product_id"],
                    serial_numbers=chosen_serials,
                    model_no=item.get("model_no") or None
                )
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))
        else:
            allocated_serials = inventory_db.allocate_units(
                collection_name=INVENTORY_COLLECTION,
                product_id=item["product_id"],
                quantity=item["quantity"],
                model_no=item.get("model_no") or None
            )
        order_item = dict(item)
        order_item["serial_numbers"] = allocated_serials
        order_items.append(order_item)

    order = order_manager(
        customer=customer_snapshot,
        items=order_items,
        payment_mode=payment_mode,
        payment_details=payment_details,
        discount=discount,
        creator=creator or {},
        warranty_years=warranty_years,
        warranty_charge=warranty_charge
    )
    order.add(collection_name=ORDERS_COLLECTION)

    logging.info(f"order {order.order_id} created successfully")
    return order.order_id


@app.post("/order/create_order/")
def create_order(request: CreateOrderRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        order_id = _fulfill_order(
            customer_id=request.customer_id,
            customer=request.customer,
            items=[item.dict() for item in request.items],
            payment_mode=request.payment_mode,
            payment_details=request.payment_details,
            discount=request.discount,
            creator={"type": "direct", "created_by": user["username"]},
            warranty_years=request.warranty_years,
            warranty_charge=request.warranty_charge
        )
        return {"message": "order created successfully", "order_id": order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order creation failed!")
        raise HTTPException(status_code=500, detail="order creation failed")


@app.get("/track_order/{order_id}")
def track_order(order_id: str, user: dict = Depends(get_current_user)):
    try:
        db = order_manager()
        dataset = db.get_data(ORDERS_COLLECTION, query={"order_id": order_id})

        if not dataset:
            raise HTTPException(status_code=404, detail="no order found with this order_id")
        return dataset[0]

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order tracking failed!")
        raise HTTPException(status_code=500, detail="order tracking failed!")


@app.post("/order/confirm_delivery/{order_id}")
def confirm_delivery(order_id: str, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = order_manager()
        result = db.update(
            ORDERS_COLLECTION,
            query={"order_id": order_id},
            update_values={"status": "delivered"}
        )

        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="no order found with this id")

        return {"message": "delivery confirmed", "order_id": order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("delivery confirmation failed")
        raise HTTPException(status_code=500, detail="delivery confirmation failed")


@app.post("/order/delete/{order_id}")
def delete_order(order_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = order_manager()
        existing = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        # Deleting an order removes the record entirely, so — same reasoning as
        # cancelling — the stock/serials it reserved at creation time must go
        # back into inventory, or it's permanently lost from stock even though
        # nothing physically shipped. Skip if it was already cancelled: that
        # restock already happened via /order/update.
        if existing and existing[0].get("status") != "cancelled" and not existing[0].get("dispatch"):
            try:
                for item in existing[0].get("items", []):
                    product_id = item.get("product_id")
                    qty = item.get("quantity", 0) or 0
                    if not product_id or qty <= 0:
                        continue
                    inventory_manager(
                        product_name=item.get("product_name", ""),
                        product_id=product_id,
                        quantity=qty,
                        model_no=item.get("model_no", ""),
                        price=item.get("price", 0),
                        tax_rate=item.get("tax_rate", 0),
                        serial_numbers=item.get("serial_numbers", []) or [],
                    ).add_or_merge(collection_name=INVENTORY_COLLECTION)
                logging.info(f"order {order_id} deleted — items restocked to inventory")
            except Exception as restock_err:
                logging.error(f"order {order_id} deleted but restocking inventory failed: {restock_err}")
        db.delete(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        return {"message": "order deleted", "order_id": order_id}
    except Exception as e:
        logging.error("order deletion failed")
        raise HTTPException(status_code=500, detail="order deletion failed!")


@app.post("/order/update/{order_id}")
def update_order(order_id: str, updated_value: OrderUpdatedValue, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = order_manager()
        updated = dict(updated_value.updated_order_value)

        existing = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no order found with this order_id")
        order = existing[0]

        # Any of these being present means this is a real edit made via the
        # Edit Order modal (as opposed to a plain status change from the
        # Update Status modal, which carries its own cancel_reason and none
        # of these keys) — a remark is mandatory for those so the order
        # history stays meaningful. Checked against the untouched `updated`
        # dict, before any of the branches below start popping keys off it.
        item_field_keys_check = {"product_name", "serial_no", "quantity", "price", "tax_rate"}
        is_edit = bool(
            (item_field_keys_check & updated.keys())
            or "discount" in updated
            or "items" in updated
            or "payment_mode" in updated
            or "company_name" in updated
            or "gst_number" in updated
        )
        remark = (updated.pop("remark", "") or "").strip()
        if is_edit and not remark:
            raise HTTPException(status_code=400, detail="a remark is required when editing an order")

        # Cancelling an order releases the stock/serials it reserved at creation
        # time (_fulfill_order deducts inventory immediately, before delivery)
        # back into inventory — otherwise every cancelled order's units are
        # permanently lost from stock even though nothing physically shipped.
        # Guarded on the order's CURRENT status so re-saving an already-cancelled
        # order (e.g. editing the cancel reason) never restocks twice.
        if updated.get("status") == "cancelled" and order.get("status") != "cancelled":
            if order.get("dispatch"):
                # already physically dispatched — nothing to give back to inventory
                logging.info(f"order {order_id} cancelled after dispatch — inventory left untouched")
            else:
                try:
                    for item in order.get("items", []):
                        product_id = item.get("product_id")
                        qty = item.get("quantity", 0) or 0
                        if not product_id or qty <= 0:
                            continue
                        inventory_manager(
                            product_name=item.get("product_name", ""),
                            product_id=product_id,
                            quantity=qty,
                            model_no=item.get("model_no", ""),
                            price=item.get("price", 0),
                            tax_rate=item.get("tax_rate", 0),
                            serial_numbers=item.get("serial_numbers", []) or [],
                        ).add_or_merge(collection_name=INVENTORY_COLLECTION)
                    logging.info(f"order {order_id} cancelled — items restocked to inventory")
                except Exception as restock_err:
                    logging.error(f"order {order_id} cancelled but restocking inventory failed: {restock_err}")

        # Marking an order "returned" needs to know exactly which product(s)
        # came back (an order can have multiple/coupled products) and, for
        # each, whether it came back in working condition or faulty — sent
        # by the caller as "returned_items": [{product_id, product_name,
        # model_no, quantity, serial_numbers, condition: "ok"|"faulty"}].
        # OK units go back into whatever category they were already stocked
        # under (restock_returned_units — merges into the matching
        # product_id+product_name+model_no lot, or creates one). Faulty
        # units are instead pushed into the "damaged" inventory category
        # (merges into an existing damaged entry for the same
        # product_id+model_no, quantity bumped up, or creates a new one).
        #
        # IMPORTANT: this runs on EVERY submission where status=="returned",
        # not just the first — once an order is already "returned", e.g. the
        # Update Status modal is reopened to correct a mistake (an item that
        # should've been "faulty" was first saved as "ok", or a second item
        # is being returned later), the old code's "only if the order wasn't
        # already returned" guard silently skipped ALL processing on every
        # later submission with no error, so the correction never reached
        # inventory even though the request looked successful. Each
        # already-processed serial number (or, for unserialized lines,
        # already-processed quantity per product_id+model_no) is tracked on
        # the order itself so re-submitting doesn't restock/damage the same
        # unit twice, while still letting genuinely NEW lines/serials in this
        # submission go through.
        if updated.get("status") == "returned":
            return_reason = (updated.get("return_reason") or "").strip()
            returned_items = updated.get("returned_items") or []
            if not return_reason:
                raise HTTPException(status_code=400, detail="a reason is required when marking an order as returned")
            if not returned_items:
                raise HTTPException(status_code=400, detail="select at least one product that was returned")

            already_serials = set(order.get("returned_serials_processed") or [])
            already_qty = dict(order.get("returned_qty_processed") or {})
            newly_processed_serials = []
            processed_records = []  # what actually got processed this submission — for order history/view

            inv_db = inventory_manager()
            for ret_item in returned_items:
                product_id = ret_item.get("product_id")
                product_name = ret_item.get("product_name", "")
                model_no = ret_item.get("model_no", "") or ""
                serials = [s for s in (ret_item.get("serial_numbers") or []) if s]
                condition = ret_item.get("condition")  # "ok" | "faulty"
                if not product_id:
                    continue

                qty_key = f"{product_id}|{model_no}"
                if serials:
                    fresh_serials = [s for s in serials if s not in already_serials]
                    if not fresh_serials:
                        continue  # every serial on this line was already processed in an earlier submission
                    quantity = len(fresh_serials)
                else:
                    already_done = int(already_qty.get(qty_key, 0) or 0)
                    requested_qty = int(ret_item.get("quantity", 0) or 0)
                    quantity = max(0, requested_qty - already_done)
                    fresh_serials = []
                    if quantity <= 0:
                        continue  # this line's quantity was already fully processed earlier

                try:
                    if condition == "faulty":
                        # Deliberately NOT using add_or_merge() here — its
                        # cross-category "serial found under a different
                        # product_type elsewhere" migration logic is meant for
                        # the manual "Add Existing Product" restock flow and
                        # isn't needed for a fresh return (the serial isn't
                        # anywhere else in inventory at this point, it was
                        # already deducted when the order was created). A plain,
                        # direct merge-by-product_id+model_no+product_type here
                        # is simpler and avoids that logic misfiring.
                        existing_damaged = inv_db.get_data(
                            collection_name=INVENTORY_COLLECTION,
                            query={"product_id": product_id, "model_no": model_no, "product_type": "damaged"}
                        )
                        damage_reason = f"returned faulty from order {order_id}: {return_reason}"
                        if existing_damaged:
                            entry = existing_damaged[0]
                            merged_serials = (entry.get("serial_numbers") or []) + list(fresh_serials)
                            new_quantity = int(entry.get("quantity", 0) or 0) + quantity
                            inv_db.update(
                                collection_name=INVENTORY_COLLECTION,
                                query={"_id": ObjectId(entry["_id"])},
                                update_values={"serial_numbers": merged_serials, "quantity": new_quantity, "reason": damage_reason}
                            )
                        else:
                            inventory_manager(
                                product_name=product_name,
                                product_id=product_id,
                                quantity=quantity,
                                model_no=model_no,
                                serial_numbers=fresh_serials,
                                product_type="damaged",
                                reason=damage_reason,
                            ).add(collection_name=INVENTORY_COLLECTION)
                    else:
                        inv_db.restock_returned_units(
                            collection_name=INVENTORY_COLLECTION,
                            product_id=product_id,
                            product_name=product_name,
                            model_no=model_no,
                            quantity=quantity,
                            serial_numbers=fresh_serials,
                        )
                except Exception as ret_err:
                    logging.error(f"order {order_id} return processing failed for {product_id} ({condition}): {ret_err}")
                    raise HTTPException(status_code=400, detail=f"could not process return for {product_name or product_id}: {ret_err}")

                if fresh_serials:
                    newly_processed_serials.extend(fresh_serials)
                else:
                    already_qty[qty_key] = int(already_qty.get(qty_key, 0) or 0) + quantity

                processed_records.append({
                    "product_id": product_id,
                    "product_name": product_name,
                    "model_no": model_no,
                    "condition": condition,
                    "quantity": quantity,
                    "serial_numbers": fresh_serials,
                })

            updated["returned_serials_processed"] = list(already_serials) + newly_processed_serials
            updated["returned_qty_processed"] = already_qty
            # Accumulate across submissions (instead of overwriting) so the
            # order's full return history — every product, its serial(s) and
            # condition — stays visible in View Order Details even if the
            # return was corrected/added-to across more than one submission.
            updated["returned_items"] = list(order.get("returned_items") or []) + processed_records
            logging.info(f"order {order_id} marked returned — {len(returned_items)} item(s) submitted, {len(newly_processed_serials)} new serial(s) processed")

        # These fields actually live inside order["items"][0], not at the
        # top level of the order document — editing them has to go through
        # the item, or they silently land as an unused stray field and the
        # UI never reflects the change.
        item_field_keys = {"product_name", "serial_no", "quantity", "price", "tax_rate"}
        touched_item_fields = item_field_keys & updated.keys()
        # discount lives at the top level already, but total_mrp depends on it too,
        # so a discount-only edit still needs to fall into the recompute branch below
        # instead of leaving a stale total_mrp.
        discount_touched = "discount" in updated

        if "items" in updated:
            # Full multi-item replace from the Edit Order modal — every item
            # in the order can now be edited (qty/price/tax/serials), not
            # just items[0], and each item keeps its own price instead of
            # sharing one combined price across the whole order.
            new_items_raw = updated.pop("items")
            if not new_items_raw:
                raise HTTPException(status_code=400, detail="order must contain at least one product")

            # Reconcile inventory against whatever changed between the old and
            # new item lists — this used to not happen at all: retyping the
            # serial numbers field, or changing quantity, only ever rewrote the
            # order document, so the old serials were never freed back to
            # stock and the new ones were never actually deducted (or even
            # checked for availability). Skipped once the order has already
            # been dispatched — the physical units are gone, so editing the
            # record afterwards shouldn't touch live stock (same guard the
            # cancellation branch above uses).
            old_items = order.get("items", [])

            # Pair each incoming item with the original line it came from,
            # via "original_index" (sent by the Edit Order modal for every
            # row that's still present after the person may have removed
            # some). This replaces a fragile zip(old_items, new_items) that
            # matched purely by POSITION — removing a middle product shifted
            # every item after it by one slot, so the backend thought that
            # product had "changed into" the next one, and the real last
            # item (now past the end of the shorter list) never got its
            # stock/serials restocked at all. Falls back to positional index
            # if a client doesn't send it, so nothing breaks if an older
            # frontend build is still deployed somewhere.
            new_items = []
            kept_indices = set()
            for i, raw in enumerate(new_items_raw):
                item = dict(raw)
                try:
                    orig_idx = int(item.pop("original_index", i))
                except (TypeError, ValueError):
                    orig_idx = i
                kept_indices.add(orig_idx)
                new_items.append((orig_idx, item))

            if not order.get("dispatch"):
                inv_db = inventory_manager()
                # process ALL restocks (freed-up serials/quantity) before ANY
                # deductions, across every line — so a serial number moved
                # from one line to another in the same edit is available
                # again by the time we try to deduct it for its new line,
                # instead of failing with "not available".
                restores = []   # (product_id, product_name, model_no, qty, serials)
                deductions = [] # (product_id, product_name, model_no, qty, serials)

                # any old line whose index isn't among the surviving rows was
                # removed entirely in this edit — its full quantity/serials
                # go back to stock, same as a cancellation would do for it.
                for idx, old_item in enumerate(old_items):
                    if idx in kept_indices:
                        continue
                    qty = int(old_item.get("quantity", 0) or 0)
                    if qty <= 0:
                        continue
                    restores.append((
                        old_item.get("product_id", ""),
                        old_item.get("product_name", ""),
                        old_item.get("model_no", "") or "",
                        qty,
                        list(old_item.get("serial_numbers", []) or [])
                    ))

                for orig_idx, new_item in new_items:
                    old_item = old_items[orig_idx] if 0 <= orig_idx < len(old_items) else {}
                    product_id = old_item.get("product_id", new_item.get("product_id", ""))
                    product_name = old_item.get("product_name", new_item.get("product_name", ""))
                    model_no = old_item.get("model_no", new_item.get("model_no", "")) or ""
                    old_serials = set(old_item.get("serial_numbers", []) or [])
                    new_serials = set(new_item.get("serial_numbers", []) or [])
                    old_qty = int(old_item.get("quantity", 0) or 0)
                    new_qty = int(new_item.get("quantity", 0) or 0)

                    removed_serials = list(old_serials - new_serials)
                    added_serials = list(new_serials - old_serials)
                    if removed_serials:
                        restores.append((product_id, product_name, model_no, len(removed_serials), removed_serials))
                    if added_serials:
                        deductions.append((product_id, product_name, model_no, len(added_serials), added_serials))

                    # the portion of quantity NOT backed by a specific serial
                    # (accessories/spare_parts can be stocked with fewer
                    # serials on file than their quantity) — only this part
                    # moves as a plain quantity adjustment; the serialed part
                    # is already handled above via removed/added_serials.
                    old_unserialized = max(0, old_qty - len(old_serials))
                    new_unserialized = max(0, new_qty - len(new_serials))
                    unserialized_delta = new_unserialized - old_unserialized
                    if unserialized_delta > 0:
                        deductions.append((product_id, product_name, model_no, unserialized_delta, []))
                    elif unserialized_delta < 0:
                        restores.append((product_id, product_name, model_no, -unserialized_delta, []))

                for product_id, product_name, model_no, qty, serials in restores:
                    if qty <= 0:
                        continue
                    inv_db.restock_returned_units(
                        collection_name=INVENTORY_COLLECTION,
                        product_id=product_id,
                        product_name=product_name,
                        model_no=model_no,
                        quantity=qty,
                        serial_numbers=serials,
                    )

                for product_id, product_name, model_no, qty, serials in deductions:
                    if qty <= 0:
                        continue
                    try:
                        if serials:
                            inv_db.allocate_specific_serials(
                                collection_name=INVENTORY_COLLECTION,
                                product_id=product_id,
                                serial_numbers=serials,
                                model_no=model_no or None,
                            )
                        else:
                            inv_db.allocate_units(
                                collection_name=INVENTORY_COLLECTION,
                                product_id=product_id,
                                quantity=qty,
                                model_no=model_no or None,
                            )
                    except Exception as e:
                        raise HTTPException(status_code=400, detail=f"{product_name or product_id}: {e}")

            computed_items = []
            for _orig_idx, raw_item in new_items:
                item = dict(raw_item)
                quantity = item.get("quantity", 0)
                price = item.get("price", 0)
                tax_rate = item.get("tax_rate", 0)
                line_amount = price * quantity
                line_tax = line_amount * tax_rate / 100
                item["line_amount"] = line_amount
                item["line_tax"] = line_tax
                item["line_total"] = line_amount + line_tax
                computed_items.append(item)

            updated["items"] = computed_items
            discount = updated.get("discount", order.get("discount", 0))
            subtotal = sum(i.get("line_amount", 0) for i in computed_items)
            tax_total = sum(i.get("line_tax", 0) for i in computed_items)
            updated["subtotal"] = subtotal
            updated["tax_total"] = tax_total
            updated["total_mrp"] = subtotal + tax_total - discount

        elif touched_item_fields or discount_touched:
            items = order.get("items", [])
            if not items:
                raise HTTPException(status_code=400, detail="order has no items to edit")
            item = dict(items[0])
            for key in touched_item_fields:
                value = updated.pop(key)
                # the item's actual field is the plural "serial_numbers" list, not "serial_no"
                if key == "serial_no":
                    item["serial_numbers"] = [value] if value else []
                else:
                    item[key] = value

            quantity = item.get("quantity", 0)
            price = item.get("price", 0)
            tax_rate = item.get("tax_rate", 0)
            line_amount = price * quantity
            line_tax = line_amount * tax_rate / 100
            item["line_amount"] = line_amount
            item["line_tax"] = line_tax
            item["line_total"] = line_amount + line_tax

            items = [item] + items[1:]
            updated["items"] = items

            # Recompute order-level totals from the items instead of trusting
            # whatever total_mrp the client sent — the client can't see other
            # items or the discount reliably, so it drifts out of sync.
            discount = updated.get("discount", order.get("discount", 0))
            subtotal = sum(i.get("line_amount", 0) for i in items)
            tax_total = sum(i.get("line_tax", 0) for i in items)
            updated["subtotal"] = subtotal
            updated["tax_total"] = tax_total
            updated["total_mrp"] = subtotal + tax_total - discount

        # company_name / gst_number live under order["customer"], not at the
        # top level either.
        customer_field_keys = {"company_name", "gst_number"}
        touched_customer_fields = customer_field_keys & updated.keys()
        if touched_customer_fields:
            customer = dict(order.get("customer", {}))
            for key in touched_customer_fields:
                customer[key] = updated.pop(key)
            updated["customer"] = customer

        if is_edit:
            history = list(order.get("edit_history", []))
            history.append({
                "edited_by": user["username"],
                "remark": remark,
                "edited_at": datetime.now(timezone.utc).isoformat()
            })
            updated["edit_history"] = history

        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values=updated)
        logging.info("order value was updated successfully.")
        return {"message": "order value was updated", "order_id": order_id, "updated_value": updated}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order cannot be updated")
        raise HTTPException(status_code=500, detail="order value cannot be updated")


@app.get("/order/")
def order(user: dict = Depends(get_current_user)):
    try:
        db = order_manager()
        dataset = db.get_data(collection_name=ORDERS_COLLECTION, query={})
        logging.info("order dataset was fetched successfully")
        return {"message": "order dataset", "dataset": dataset}
    except Exception as e:
        logging.error("order dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="order dataset cannot be fetched")


# =========================================================
# SHIPMENT
# =========================================================

def sync_shipment_parts_to_inventory(shipment: dict, received_date: str):
    """
    Push a received shipment's parts into inventory, bucketed by each part's
    status: "assembly" parts -> inventory spare_parts, "purchase" and
    "warranty" parts -> inventory service_parts (kept apart there via
    part_category so the two never merge into one entry). Warranty parts
    also get a warranty_until date computed from this product's warranty
    duration + the shipment's received_date, so inventory can later show
    them as "under warranty" / "over warranty".
    Non-fatal: caller decides what to do if this raises / returns a failure.
    """
    spare_parts_needed = {}      # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}
    purchase_parts_needed = {}   # (product_name, part_name) -> total qty
    warranty_parts_needed = {}   # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}

    for product in shipment.get("products", []):
        parent_product_name = product.get("product_name", "")
        product_warranty_until = compute_warranty_until(received_date, product.get("warranty", ""))
        for part in product.get("parts", []):
            name = (part.get("part_name") or "").strip()
            qty = part.get("quantity", 0) or 0
            if not name or qty <= 0:
                continue
            status = part.get("status", "assembly")
            key = (parent_product_name, name)

            if status == "assembly":
                entry = spare_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                entry["quantity"] += qty
                if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                    entry["warranty_until"] = product_warranty_until
            elif status == "purchase":
                purchase_parts_needed[key] = purchase_parts_needed.get(key, 0) + qty
            else:  # "warranty"
                entry = warranty_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                entry["quantity"] += qty
                if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                    entry["warranty_until"] = product_warranty_until

    if not (spare_parts_needed or purchase_parts_needed or warranty_parts_needed):
        return "no_parts"

    inv_db = inventory_manager()
    sync_results = []
    if spare_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": v["quantity"],
                    "warranty_until": v["warranty_until"]}
                   for (pn, n), v in spare_parts_needed.items()],
            product_type="spare_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
        )
    if purchase_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": q, "part_category": "purchase"}
                   for (pn, n), q in purchase_parts_needed.items()],
            product_type="service_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
        )
    if warranty_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": v["quantity"], "part_category": "warranty",
                    "warranty_until": v["warranty_until"]}
                   for (pn, n), v in warranty_parts_needed.items()],
            product_type="service_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
        )
    return sync_results


@app.get("/shipment/")
def shipment(user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = shipment_manager()
        dataset = db.get_data(collection_name=SHIPMENT_COLLECTION, query={})
        logging.info("shipment dataset was fetched successfully")
        return {"message": "shipment dataset", "dataset": dataset}
    except Exception as e:
        logging.error("shipment dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="shipment dataset cannot be fetched")


@app.get("/shipment/{shipment_id}")
def track_shipment(shipment_id: str, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = shipment_manager()
        result = db.shipment_tracking(collection_name=SHIPMENT_COLLECTION, shipment_id=shipment_id)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment tracking failed!")
        raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")


@app.post("/shipment/create")
def create_shipment(request: CreateShipmentRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        shipment_dict = {
            "company_name": request.company_name,
            "company_address": request.company_address,
            "products": [product.dict() for product in request.products],
        }
        shipment_item = shipment_manager(
            company_name=request.company_name,
            company_address=request.company_address,
            dispatch_date=request.dispatch_date,
            received_date=request.received_date or None,
            products=shipment_dict["products"],
            created_by=user["username"],
        )
        _, shipment_id = shipment_item.add(collection_name=SHIPMENT_COLLECTION)
        logging.info("shipment created successfully")

        inventory_sync = "skipped"
        # if the received date was already filled in at creation time (the
        # wizard's optional step-1 field), sync parts to inventory right away —
        # otherwise the shipment shows as "received" but never gets the chance
        # to run through mark_shipment_received, and its parts never land in inventory.
        if request.received_date:
            try:
                inventory_sync = sync_shipment_parts_to_inventory(shipment_dict, request.received_date)
            except Exception as inv_err:
                logging.error(f"shipment {shipment_id} created received but parts->inventory sync failed: {inv_err}")
                inventory_sync = f"failed: {inv_err}"

        return {"message": "shipment created successfully", "shipment_id": shipment_id, "inventory_sync": inventory_sync}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment creation failed!")
        raise HTTPException(status_code=500, detail="shipment creation failed")


@app.post("/shipment/mark_received/{shipment_id}")
def mark_shipment_received(shipment_id: str, request: ShipmentReceivedRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        shipment = existing[0]
        db.mark_received(collection_name=SHIPMENT_COLLECTION, shipment_id=shipment_id, received_date=request.received_date)

        # Kept non-fatal: the shipment is already marked received above, so an
        # inventory hiccup here is reported back but doesn't roll that back.
        try:
            inventory_sync = sync_shipment_parts_to_inventory(shipment, request.received_date)
        except Exception as inv_err:
            logging.error(f"shipment {shipment_id} received but parts->inventory sync failed: {inv_err}")
            inventory_sync = f"failed: {inv_err}"

        return {
            "message": "shipment marked as received",
            "shipment_id": shipment_id,
            "received_date": request.received_date,
            "inventory_sync": inventory_sync,
        }

    except HTTPException:
        raise
    except Exception as e:
        logging.error("marking shipment as received failed")
        raise HTTPException(status_code=500, detail="shipment could not be marked as received")


@app.post("/shipment/update/{shipment_id}")
def update_shipment(shipment_id: str, request: ShipmentUpdateRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        updated = dict(request.updated_values)
        # keep status in sync if the caller is editing received_date directly
        if "received_date" in updated:
            updated["status"] = "received" if updated["received_date"] else "pending"

        db.update(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id}, update_values=updated)
        logging.info("shipment value was updated successfully.")
        return {"message": "shipment value was updated", "shipment_id": shipment_id, "updated_value": updated}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment cannot be updated")
        raise HTTPException(status_code=500, detail="shipment value cannot be updated")


@app.post("/shipment/delete/{shipment_id}")
def delete_shipment(shipment_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = shipment_manager()
        db.delete(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        return {"message": "shipment deleted", "shipment_id": shipment_id}
    except Exception as e:
        logging.error("shipment deletion failed")
        raise HTTPException(status_code=500, detail="shipment deletion failed!")


# =========================================================
# ASSEMBLY
# =========================================================

@app.get("/assembly/")
def assembly(user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        dataset = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={})
        logging.info("assembly dataset was fetched successfully")
        return {"message": "assembly dataset", "dataset": dataset}
    except Exception as e:
        logging.error("assembly dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="assembly dataset cannot be fetched")


@app.get("/assembly/available_parts")
def available_parts_for_assembly(user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    """
    Spare parts currently sitting in inventory — the pool an assembly's parts
    are pulled from. This stock is fed by shipments: a shipment part marked
    "assembly" lands in inventory as product_type="spare_parts" as soon as
    the shipment is marked received (see mark_shipment_received above).

    Only parts that already carry hologram numbers are surfaced here — each
    assembled unit needs one, so a part with none on file can't be used to
    build one. "hologram_available" tells the UI how many units of this part
    can actually be assembled (which may be less than raw quantity, if only
    some units have had a hologram number added yet).
    """
    try:
        inv_db = inventory_manager()
        dataset = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_type": "spare_parts"})

        pool = {}
        for entry in dataset:
            name = entry.get("product_name", "")
            qty = int(entry.get("quantity", 0) or 0)
            hologram_count = len(entry.get("hologram_numbers") or [])
            if not name or qty <= 0 or hologram_count <= 0:
                continue
            agg = pool.setdefault(name, {"quantity": 0, "hologram_available": 0})
            agg["quantity"] += qty
            agg["hologram_available"] += hologram_count

        available = [
            {"part_name": name, "quantity": v["quantity"], "hologram_available": v["hologram_available"]}
            for name, v in pool.items()
        ]
        return {"message": "available parts", "dataset": available}
    except Exception as e:
        logging.error("available parts for assembly cannot be fetched")
        raise HTTPException(status_code=500, detail="available parts cannot be fetched")


@app.get("/assembly/{assembly_id}")
def track_assembly(assembly_id: str, user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        result = db.assembly_tracking(collection_name=ASSEMBLY_COLLECTION, assembly_id=assembly_id)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly tracking failed!")
        raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")


@app.post("/assembly/create")
def create_assembly(request: CreateAssemblyRequest, user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    try:
        parts_used = [part.dict() for part in request.parts_used]

        if len(request.serials) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match the assembly quantity")
        serial_values = [s.serial_number.strip() for s in request.serials]
        if any(not s for s in serial_values):
            raise HTTPException(status_code=400, detail="every unit needs a serial number")
        if len(set(serial_values)) != len(serial_values):
            raise HTTPException(status_code=400, detail="serial numbers must be unique within this batch")

        # sum up everything sourced from inventory, merging duplicate part names
        needed_from_inventory: dict[str, int] = {}
        for p in parts_used:
            if p["source"] != "inventory" or p["quantity"] <= 0:
                continue
            needed_from_inventory[p["part_name"]] = needed_from_inventory.get(p["part_name"], 0) + p["quantity"]

        if not needed_from_inventory:
            raise HTTPException(
                status_code=400,
                detail="add at least one part from inventory — its hologram numbers supply the assembled units' hologram numbers",
            )

        # at least one inventory part must have enough quantity at a 1:1 ratio
        # with the assembly quantity — that's the hologram-bearing part, and its
        # hologram numbers (one per unit) become each finished unit's hologram
        # number. If more than one part qualifies, that's not an error — extra
        # (zyada) is fine, we just pick one; only a shortage (kam) blocks.
        hologram_candidates = [name for name, qty in needed_from_inventory.items() if qty >= request.quantity]
        if not hologram_candidates:
            raise HTTPException(
                status_code=400,
                detail="at least one part from inventory must have quantity at least equal to the assembly quantity — "
                       "that part supplies the hologram number for each assembled unit",
            )
        # pick the first qualifying part (in the order it was entered) as the
        # hologram-bearing part
        hologram_part_name = hologram_candidates[0]

        # how much of each inventory part actually gets consumed: the hologram
        # part only gives up exactly `request.quantity` (one per unit) — any
        # extra the user entered for it stays untouched in inventory. Every
        # other part is consumed at the full quantity entered for it.
        consume_amounts = {
            name: (request.quantity if name == hologram_part_name else qty)
            for name, qty in needed_from_inventory.items()
        }

        inv_db = inventory_manager()

        # validate stock (and, for the hologram part, hologram numbers on file) is
        # sufficient for EVERY part before deducting any of them — otherwise a
        # shortage on part #2 would leave part #1 already (irreversibly) deducted
        for part_name, qty in consume_amounts.items():
            have = inv_db.get_available_quantity_by_name(
                collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts"
            )
            if have < qty:
                raise HTTPException(
                    status_code=400,
                    detail=f"not enough '{part_name}' in inventory spare parts (need {qty}, have {have})",
                )
            if part_name == hologram_part_name:
                hologram_have = inv_db.get_hologram_available_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts"
                )
                if hologram_have < request.quantity:
                    raise HTTPException(
                        status_code=400,
                        detail=f"not enough hologram-tagged '{part_name}' in inventory (need {request.quantity}, have {hologram_have})",
                    )

        # stock confirmed for every part — now actually deduct
        hologram_numbers: list[str] = []
        for part_name, qty in consume_amounts.items():
            if part_name == hologram_part_name:
                hologram_numbers = inv_db.allocate_hologram_numbers_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=request.quantity,
                )
                # any quantity beyond one-per-unit is left untouched in
                # inventory — we only take what's needed
            else:
                inv_db.consume_quantity(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=qty,
                )

        if len(hologram_numbers) != request.quantity:
            raise HTTPException(status_code=500, detail="could not allocate a hologram number for every assembled unit")

        serials = [
            {"serial_number": s.serial_number.strip(), "hologram_number": hologram_numbers[i]}
            for i, s in enumerate(request.serials)
        ]

        assembly_item = assembly_manager(
            product_name=request.product_name,
            product_id=request.product_id,
            model_number=request.model_number,
            quantity=request.quantity,
            parts_used=parts_used,
            serials=serials,
            created_by=user["username"],
        )
        _, assembly_id = assembly_item.add(collection_name=ASSEMBLY_COLLECTION)
        logging.info("assembly created successfully")
        return {"message": "assembly created successfully", "assembly_id": assembly_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly creation failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/assembly/mark_completed/{assembly_id}")
def mark_assembly_completed(assembly_id: str, user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")
        assembly = existing[0]

        db.mark_completed(collection_name=ASSEMBLY_COLLECTION, assembly_id=assembly_id)

        # push the freshly built units into inventory - merges into a matching
        # product_name + product_id + model_no entry if one exists, else creates one.
        # Kept non-fatal: the assembly is already marked completed above, so an
        # inventory hiccup here is reported back but doesn't roll that back.
        inventory_sync = "skipped"
        try:
            serial_numbers = [s.get("serial_number") for s in assembly.get("serials", []) if s.get("serial_number")]
            inv_db = inventory_manager()
            sync_result = inv_db.add_from_assembly(
                collection_name=INVENTORY_COLLECTION,
                product_name=assembly.get("product_name"),
                product_id=assembly.get("product_id"),
                model_no=assembly.get("model_number"),
                quantity=assembly.get("quantity", 0),
                serial_numbers=serial_numbers,
                purchase_date=datetime.now(timezone.utc).date().isoformat(),
            )
            inventory_sync = sync_result["mode"]  # "merged" | "created"
        except Exception as inv_err:
            logging.error(f"assembly {assembly_id} completed but inventory sync failed: {inv_err}")
            inventory_sync = f"failed: {inv_err}"

        return {"message": "assembly marked as completed", "assembly_id": assembly_id, "inventory_sync": inventory_sync}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("marking assembly as completed failed")
        raise HTTPException(status_code=500, detail="assembly could not be marked as completed")


@app.post("/assembly/update/{assembly_id}")
def update_assembly(assembly_id: str, request: AssemblyUpdateRequest, user: dict = Depends(require_role("assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")

        updated = dict(request.updated_values)
        db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id}, update_values=updated)
        logging.info("assembly value was updated successfully.")
        return {"message": "assembly value was updated", "assembly_id": assembly_id, "updated_value": updated}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly cannot be updated")
        raise HTTPException(status_code=500, detail="assembly value cannot be updated")


@app.post("/assembly/delete/{assembly_id}")
def delete_assembly(assembly_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = assembly_manager()
        db.delete(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        return {"message": "assembly deleted", "assembly_id": assembly_id}
    except Exception as e:
        logging.error("assembly deletion failed")
        raise HTTPException(status_code=500, detail="assembly deletion failed!")


DISPATCH_MEDIA_STALE_DAYS = int(os.getenv("DISPATCH_MEDIA_STALE_DAYS", "5"))


class DamageReportRequest(BaseModel):
    issue: str
    image: str  # base64 data URL - required, enforced below


def send_damage_report_email(allocation_id: str, product_label: str, issue: str, image_data_url: str, reported_by: str):
    """
    Emails the damage photo + issue description to GMAIL_NOTIFY_RECEIVER right
    away, before the image gets purged from Mongo. Never raises - a failed
    email should not block the damage report from being saved.
    """
    if not GMAIL_SENDER_EMAIL or not GMAIL_SENDER_APP_PASSWORD or not GMAIL_NOTIFY_RECEIVER:
        logging.error("gmail credentials not configured - skipping damage report email")
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = f"Damaged product reported - allocation {allocation_id[:8]}"
        msg["From"] = GMAIL_SENDER_EMAIL
        msg["To"] = GMAIL_NOTIFY_RECEIVER
        msg.set_content(
            f"Allocation ID: {allocation_id}\n"
            f"Product: {product_label}\n"
            f"Reported by: {reported_by}\n"
            f"Reported at: {datetime.now(timezone.utc).isoformat()}\n\n"
            f"Issue:\n{issue}\n\n"
            f"(Photo attached. This image will be deleted from the database "
            f"{DAMAGE_IMAGE_RETENTION_DAYS} day(s) after being reported.)"
        )

        if image_data_url.startswith("data:"):
            header, b64data = image_data_url.split(",", 1)
            mime = header.split(":")[1].split(";")[0]  # e.g. image/jpeg
            subtype = mime.split("/")[1] if "/" in mime else "jpeg"
            img_bytes = base64.b64decode(b64data)
            msg.add_attachment(img_bytes, maintype="image", subtype=subtype, filename=f"damage_{allocation_id[:8]}.{subtype}")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(GMAIL_SENDER_EMAIL, GMAIL_SENDER_APP_PASSWORD)
            smtp.send_message(msg)

        logging.info(f"damage report email sent for allocation {allocation_id}")
        return True
    except Exception as e:
        logging.error(f"failed to send damage report email for allocation {allocation_id}: {e}")
        return False


# ---------- performance helpers ----------
_bg_lock = threading.Lock()
_bg_last = {}
_bg_running = set()


def run_in_background(name: str, fn, min_interval: int = 1800):
    """Runs housekeeping jobs (image purge / Drive migration) off the request path, at most once
    per `min_interval` seconds and never two copies at once, so page loads no longer wait for them."""
    now = time.time()
    with _bg_lock:
        if name in _bg_running or now - _bg_last.get(name, 0) < min_interval:
            return
        _bg_running.add(name)
        _bg_last[name] = now

    def _job():
        try:
            fn()
        except Exception as e:
            logging.error(f"background job {name} failed: {e}")
        finally:
            with _bg_lock:
                _bg_running.discard(name)

    threading.Thread(target=_job, daemon=True).start()


def ensure_indexes():
    """Idempotent — creates indexes on the fields the list/lookup queries filter by."""
    wanted = {
        ALLOCATION_COLLECTION: ["allocation_id", "allocated_by", "allocation_type", "return_status"],
        ORDERS_COLLECTION: ["order_id", "status", "creator.raised_by"],
        REQUESTS_COLLECTION: ["request_id", "raised_by", "status"],
        INVENTORY_COLLECTION: ["product_id", "product_type"],
        ACCOUNTS_COLLECTION: ["username", "role"],
        CUSTOMER_COLLECTION: ["customer_id"],
        SERVICE_COLLECTION: ["service_id"],
    }
    db = mongodbclient().database
    for coll, fields in wanted.items():
        for field in fields:
            try:
                db[coll].create_index(field, background=True)
            except Exception as e:
                logging.error(f"index {coll}.{field} skipped: {e}")


def _warm_up_db():
    """Opens the first DB connection at startup so the first page load doesn't pay for it."""
    try:
        t = time.perf_counter()
        mongodbclient().client.admin.command("ping")
        logging.info(f"mongodb warm-up ping took {(time.perf_counter() - t) * 1000:.0f} ms")
    except Exception as e:
        logging.error(f"mongodb warm-up failed: {e}")
    ensure_indexes()


@app.on_event("startup")
def _create_indexes_on_startup():
    threading.Thread(target=_warm_up_db, daemon=True).start()


def purge_stale_damage_images():
    """
    Finds damage reports whose image is still stored and is older than
    DAMAGE_IMAGE_RETENTION_DAYS, then clears just the image field (issue text
    and metadata are kept). Runs automatically whenever allocations are
    loaded. Never raises - a hiccup here should not break the page.
    """
    try:
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=DAMAGE_IMAGE_RETENTION_DAYS)).isoformat()
        stale_query = {
            "damage_report.reported_at": {"$ne": None, "$lt": cutoff_iso},
            "damage_report.image": {"$ne": None}
        }
        db = mongodbclient()
        stale_docs = db.get_data(collection_name=ALLOCATION_COLLECTION, query=stale_query)
        purged_count = 0
        for doc in stale_docs:
            allocation_id = doc.get("allocation_id")
            db.update_data(
                collection_name=ALLOCATION_COLLECTION,
                query={"allocation_id": allocation_id},
                update_values={"damage_report.image": None, "damage_report.image_purged": True}
            )
            purged_count += 1
        if purged_count:
            logging.info(f"purged {purged_count} stale damage report image(s)")
        return purged_count
    except Exception as e:
        logging.error(f"stale damage image purge skipped due to error: {e}")
        return 0


def migrate_stale_dispatch_media():
    """
    Same idea as service_detail.migrate_stale_media(), applied to the
    "dispatch" sub-document embedded on orders and spare-part allocations:
    finds dispatch records whose image is still a raw base64 blob and is
    older than DISPATCH_MEDIA_STALE_DAYS (default 5 days), uploads it to
    Google Drive, and replaces the field in Mongo with a placeholder +
    the Drive link. Runs automatically on every dispatch queue load. Never
    raises - a Drive/network hiccup should not break the page.
    """
    try:
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=DISPATCH_MEDIA_STALE_DAYS)).isoformat()
        stale_query = {
            "dispatch.media_updated_at": {"$ne": None, "$lt": cutoff_iso},
            "dispatch.image": {"$regex": "^data:"}
        }

        migrated_count = 0
        for collection_name, id_field in ((ORDERS_COLLECTION, "order_id"), (ALLOCATION_COLLECTION, "allocation_id")):
            db = mongodbclient()
            stale_docs = db.get_data(collection_name=collection_name, query=stale_query)
            for doc in stale_docs:
                record_id = doc.get(id_field)
                image_val = (doc.get("dispatch") or {}).get("image") or ""
                if not image_val.startswith("data:"):
                    continue
                try:
                    link = upload_base64_to_drive(image_val, filename=f"dispatch_{record_id}_image")
                    db.update_data(
                        collection_name=collection_name,
                        query={id_field: record_id},
                        update_values={"dispatch.image": GDRIVE_PLACEHOLDER, "dispatch.image_drive_link": link}
                    )
                    migrated_count += 1
                except Exception as media_err:
                    logging.error(f"failed to migrate dispatch image for {id_field} {record_id}: {media_err}")

        if migrated_count:
            logging.info(f"migrated dispatch images to Google Drive for {migrated_count} record(s)")
        return migrated_count
    except Exception as e:
        logging.error(f"stale dispatch media migration skipped due to error: {e}")
        return 0


@app.get("/dispatch/")
def dispatch_queue(user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        run_in_background("migrate_dispatch_media", migrate_stale_dispatch_media, 600)
        odb = order_manager()
        all_orders = odb.get_data(collection_name=ORDERS_COLLECTION, query={"status": "processing"})
        pending_orders = [o for o in all_orders if not o.get("dispatch")]

        adb = allocation_manager()
        all_spare = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_type": "spare_part"})
        pending_spare = [a for a in all_spare if not a.get("dispatch")]

        all_alloc = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={})
        all_product_alloc = [a for a in all_alloc if a.get("allocation_type") != "spare_part" and a.get("sent_to_dispatch")]
        pending_product_alloc = [a for a in all_product_alloc if not a.get("dispatch")]

        dispatched_orders = [o for o in all_orders if o.get("dispatch")]
        dispatched_spare = [a for a in all_spare if a.get("dispatch")]
        dispatched_product_alloc = [a for a in all_product_alloc if a.get("dispatch")]

        logging.info("dispatch queue was fetched successfully")
        return {
            "message": "dispatch queue",
            "pending_orders": pending_orders,
            "pending_spare_parts": pending_spare,
            "pending_product_allocations": pending_product_alloc,
            "dispatched_orders": dispatched_orders,
            "dispatched_spare_parts": dispatched_spare,
            "dispatched_product_allocations": dispatched_product_alloc
        }
    except Exception as e:
        logging.error("dispatch queue could not be fetched")
        raise HTTPException(status_code=500, detail="dispatch queue could not be fetched")


# =========================================================
# Attendance — daily biometric upload, monthly report, and
# automatic WhatsApp "you are late" reminders via Twilio.
# Admin-only end to end (see require_role("admin") below and
# common_auth.js's ROLE_ACCESS for the page itself).
# =========================================================

class _AttendanceTableParser(HTMLParser):
    """
    Minimal dependency-free <table> reader (stdlib html.parser only — no
    lxml/html5lib needed, unlike pandas.read_html which requires one of
    those and silently fails on servers that don't have them installed).
    Reads every <tr>, and within it every <td>/<th> cell's text, into a
    plain list of rows — exactly what the biometric machine's "Daily
    Present List" export needs (it's an HTML table saved with a .xls
    extension).
    """
    def __init__(self):
        super().__init__()
        self.rows = []
        self._current_row = None
        self._current_cell = None
        self._in_cell = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._current_row = []
        elif tag in ("td", "th"):
            self._in_cell = True
            self._current_cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            if self._current_row is not None:
                self._current_row.append("".join(self._current_cell).strip())
            self._in_cell = False
            self._current_cell = None
        elif tag == "tr":
            if self._current_row is not None:
                self.rows.append(self._current_row)
            self._current_row = None

    def handle_data(self, data):
        if self._in_cell and self._current_cell is not None:
            self._current_cell.append(data)


def parse_attendance_table(html_text: str):
    parser = _AttendanceTableParser()
    parser.feed(html_text)
    return [r for r in parser.rows if any((c or "").strip() for c in r)]


def get_late_threshold() -> str:
    db = mongodbclient()
    doc = db.get_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"})
    return doc[0].get("value", "10:00") if doc else "10:00"


def find_employee_phone(db, employee_name: str) -> Optional[str]:
    """
    Looks up an employee's WhatsApp/mobile number from the single accounts
    (user) collection instead of a separate contacts list. Matches the
    biometric device's "Employee Name" against each account's "name" field
    case-insensitively (device exports and account records don't always
    agree on capitalization), so "Rahul Sharma", "RAHUL SHARMA" and
    "rahul sharma" are all treated as the same person.
    """
    name = (employee_name or "").strip()
    if not name:
        return None
    match = db.get_data(
        collection_name=ACCOUNTS_COLLECTION,
        query={"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    return match[0].get("phone") if match else None


def send_whatsapp_late_reminder(phone_number: str, employee_name: str, in_time: str) -> bool:
    """
    Sends a "you are late today" WhatsApp message via Twilio.
    Requires the `twilio` package (pip install twilio) and these env vars:
      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
      (TWILIO_WHATSAPP_FROM looks like "whatsapp:+14155238886")
    Silently returns False (and logs why) if any of that isn't set up yet,
    so a missing Twilio config never blocks the attendance upload itself.
    """
    if TwilioClient is None:
        logging.error("twilio package not installed — run `pip install twilio` to enable late reminders")
        return False
    sid = os.getenv("TWILIO_ACCOUNT_SID")
    token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_FROM")
    if not (sid and token and from_whatsapp):
        logging.error("Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM")
        return False
    try:
        client = TwilioClient(sid, token)
        to = phone_number if phone_number.startswith("whatsapp:") else f"whatsapp:{phone_number}"
        client.messages.create(
            from_=from_whatsapp,
            to=to,
            body=f"Hi {employee_name}, you clocked in at {in_time} today which is after office start time. You are marked LATE today. Please try to reach on time."
        )
        return True
    except Exception as e:
        logging.error(f"failed to send whatsapp reminder to {phone_number}: {e}")
        return False


@app.get("/attendance/late_threshold")
def get_late_threshold_endpoint(user: dict = Depends(require_role("admin"))):
    return {"late_time": get_late_threshold()}


@app.post("/attendance/late_threshold")
def set_late_threshold_endpoint(request: LateThresholdRequest, user: dict = Depends(require_role("admin"))):
    try:
        db = mongodbclient()
        existing = db.get_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"})
        if existing:
            db.update_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"},
                            update_values={"value": request.late_time})
        else:
            db.add(collection_name=ATTENDANCE_SETTINGS_COLLECTION, dictionary={"key": "late_threshold", "value": request.late_time})
        return {"message": "late threshold updated", "late_time": request.late_time}
    except Exception as e:
        logging.error("late threshold could not be updated")
        raise HTTPException(status_code=500, detail="late threshold could not be updated")


@app.get("/attendance/")
def get_attendance(date: str = Query(None), month: str = Query(None), user: dict = Depends(require_role("admin"))):
    """date="YYYY-MM-DD" for one day's list, or month="YYYY-MM" for that month's records (monthly report)."""
    try:
        db = mongodbclient()
        query = {}
        if date:
            query["date"] = date
        elif month:
            query["date"] = {"$regex": f"^{re.escape(month)}"}
        dataset = db.get_data(collection_name=ATTENDANCE_COLLECTION, query=query)
        return {"message": "attendance dataset", "dataset": dataset}
    except Exception as e:
        logging.error("attendance dataset could not be fetched")
        raise HTTPException(status_code=500, detail="attendance dataset could not be fetched")


@app.post("/attendance/upload")
async def upload_attendance(file: UploadFile = File(...), user: dict = Depends(require_role("admin"))):
    """
    Takes the daily biometric export as-is (the "DailyPresentList_*.xls" file
    — really an HTML table saved with an .xls extension) and:
      1. reads the date from its "Date : DD-Mon-YYYY" header,
      2. stores one attendance record per employee for that date
         (re-uploading the same day's file updates those records instead of
         duplicating them),
      3. compares each employee's In-Time against the configured late
         threshold and, for anyone late who hasn't already been messaged for
         that date, sends a WhatsApp "you are late today" reminder via
         Twilio (only for employees whose name matches an account in the
         accounts/user collection with a phone number saved — matched
         case-insensitively since device exports and account records don't
         always agree on capitalization).
    """
    try:
        raw_bytes = await file.read()
        raw = raw_bytes.decode("utf-8", errors="ignore")

        date_match = re.search(r"Date\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})", raw)
        if not date_match:
            raise HTTPException(status_code=400, detail="could not find the attendance date (expected a 'Date : DD-Mon-YYYY' header) in this file")
        att_date = datetime.strptime(date_match.group(1), "%d-%b-%Y").strftime("%Y-%m-%d")

        try:
            table_rows = parse_attendance_table(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="could not read an attendance table out of this file")
        if not table_rows or len(table_rows) < 2:
            raise HTTPException(status_code=400, detail="no attendance table found in this file")

        header = [h.strip() for h in table_rows[0]]

        def col_index(name):
            for i, h in enumerate(header):
                if h.strip().lower() == name.lower():
                    return i
            return -1

        idx_emp_code = col_index("Emp Code")
        idx_name = col_index("Employee Name")
        idx_dept = col_index("Department")
        idx_branch = col_index("Branch")
        idx_in = col_index("In-Time")
        idx_out = col_index("Out-Time")
        idx_status = col_index("Status")
        if idx_emp_code == -1 or idx_name == -1:
            raise HTTPException(status_code=400, detail="this file's table doesn't look like the expected attendance format (missing Emp Code / Employee Name columns)")

        def cell(row, idx):
            return row[idx].strip() if idx != -1 and idx < len(row) else ""

        threshold_str = get_late_threshold()
        threshold_time = datetime.strptime(threshold_str, "%H:%M").time()

        db = mongodbclient()
        records_saved = 0
        late_reminders_sent = []
        late_no_contact = []

        for row in table_rows[1:]:
            emp_code = cell(row, idx_emp_code)
            if not emp_code:
                continue
            employee_name = cell(row, idx_name)
            department = cell(row, idx_dept)
            branch = cell(row, idx_branch)
            in_time_str = cell(row, idx_in)
            out_time_str = cell(row, idx_out)
            status = cell(row, idx_status)

            is_late = "LT" in status.upper()
            if in_time_str:
                try:
                    is_late = datetime.strptime(in_time_str, "%H:%M").time() > threshold_time
                except ValueError:
                    pass  # fall back to the device's own P-LT flag above

            existing = db.get_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code})
            reminder_already_sent = bool(existing[0].get("reminder_sent")) if existing else False

            record = {
                "date": att_date, "emp_code": emp_code, "employee_name": employee_name,
                "department": department, "branch": branch, "in_time": in_time_str,
                "out_time": out_time_str, "status": status, "is_late": is_late,
                "reminder_sent": reminder_already_sent,
            }
            if existing:
                db.update_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code}, update_values=record)
            else:
                db.add(collection_name=ATTENDANCE_COLLECTION, dictionary=record)
            records_saved += 1

            if is_late and not reminder_already_sent:
                phone = find_employee_phone(db, employee_name)
                if phone:
                    if send_whatsapp_late_reminder(phone, employee_name, in_time_str):
                        db.update_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code},
                                        update_values={"reminder_sent": True})
                        late_reminders_sent.append(employee_name)
                else:
                    late_no_contact.append(employee_name)

        logging.info(f"attendance uploaded for {att_date}: {records_saved} record(s), {len(late_reminders_sent)} reminder(s) sent")
        return {
            "message": "attendance uploaded",
            "date": att_date,
            "records_saved": records_saved,
            "late_reminders_sent": late_reminders_sent,
            "late_without_contact": late_no_contact,  # late today but no WhatsApp number saved yet
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error("attendance upload failed")
        raise HTTPException(status_code=500, detail="attendance file could not be processed")


@app.post("/dispatch/confirm/order/{order_id}")
def confirm_order_dispatch(order_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = order_manager()
        matches = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        if not matches:
            raise HTTPException(status_code=404, detail="order not found")
        order = matches[0]
        customer = order.get("customer", {})
        dispatch_info = {
            "docket_no": request.docket_no,
            "invoice_no": request.invoice_no,
            "invoice_date": request.invoice_date,
            "mode_of_delivery": request.mode_of_delivery,
            "bill_to_address": {"company_name": customer.get("company_name", ""), "address": customer.get("company_address", "")},
            "ship_to_different": request.ship_to_different,
            "ship_to_address": request.ship_to_address if request.ship_to_different else None,
            "image": request.image,
            "media_updated_at": datetime.now(timezone.utc).isoformat() if request.image else None,
            "dispatched_by": user["username"]
        }
        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values={"dispatch": dispatch_info})
        logging.info(f"order {order_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "order_id": order_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.post("/dispatch/confirm/spare_part/{allocation_id}")
def confirm_spare_part_dispatch(allocation_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        dispatch_info = {
            "docket_no": request.docket_no,
            "invoice_no": request.invoice_no,
            "invoice_date": request.invoice_date,
            "mode_of_delivery": request.mode_of_delivery,
            "ship_to_different": request.ship_to_different,
            "ship_to_address": request.ship_to_address if request.ship_to_different else None,
            "image": request.image,
            "media_updated_at": datetime.now(timezone.utc).isoformat() if request.image else None,
            "dispatched_by": user["username"]
        }
        db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id}, update_values={"dispatch": dispatch_info})
        logging.info(f"spare part allocation {allocation_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("spare part dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.get("/service/")
def services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={})
        logging.info("service dataset was fetched successfully")
        return {"message": "service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/services/create")
def create_service(request: ServiceRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        service = service_detail(product_id=request.product_id, serial_no=request.serial_no)
        service.add_service(
            collection_name=SERVICE_COLLECTION,
            purchase_date=request.purchase_date,
            issue=request.issue,
            image=request.image,
            video=request.video,
            technician_id=request.technician_id,
            location=request.location,
            spare_parts=request.spare_parts
        )
        logging.info(f"service creation was successful with service_id {service.service_id}!")

        if request.video:
            _raise_media_review_request(service.service_id, user["username"])

        return {"message": "service creation was successful!", "service_id": service.service_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("service creation failed!")
        raise HTTPException(status_code=500, detail="service cannot be created!")


@app.post("/service/delete/{service_id}")
def delete_service(service_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.delete_service(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        logging.info(f"service was deleted successfully service id {service_id}")
        return {"message": "service deletion was successful", "service_id": service_id}
    except Exception as e:
        logging.error("service deletion was failed!")
        raise HTTPException(status_code=500, detail="service cannot be deleted")


@app.post("/service/update/{service_id}")
def update_service(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.update_service_status(
            service_status=request.service_status,
            reason=request.reason,
            collection_name=SERVICE_COLLECTION,
            query={"service_id": service_id},
            image=request.image,
            video=request.video,
            spare_parts_used=request.spare_parts_used,
            spare_parts=request.spare_parts,
            service_charges=request.service_charges,
            parts_used=[p.dict() for p in request.parts_used]
        )

        hologram_mismatch = False
        if request.service_status == "completed" and request.spare_parts_used:
            try:
                hologram_mismatch = _swap_faulty_part(service_id, [p.dict() for p in request.parts_used])
            except Exception as swap_err:
                logging.error(f"service {service_id} completed but faulty-part swap failed: {swap_err}")

        # auto-resolve any pending status_update requests raised for this service,
        # since admin/accounts just applied the change directly from the Service page
        req_db = request_manager()
        pending = req_db.get_data(collection_name=REQUESTS_COLLECTION,
                                   query={"request_type": "status_update", "status": "pending",
                                          "details.service_id": service_id})
        for req in pending:
            req_db.set_status(collection_name=REQUESTS_COLLECTION, request_id=req["request_id"],
                               status="approved", resolved_by=user["username"])

        logging.info("service was updated")
        return {"message": "service was updated successfully", "service_id": service_id, "hologram_mismatch": hologram_mismatch}
    except Exception as e:
        logging.error("service updation was unsuccessful!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/service/request_status_update/{service_id}")
def request_status_update(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        req = request_manager(
            request_type="status_update",
            raised_by=user["username"],
            details={
                "service_id": service_id,
                "service_status": request.service_status,
                "reason": request.reason,
                "spare_parts": request.spare_parts,
                "spare_parts_used": request.spare_parts_used,
                "service_charges": request.service_charges
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        logging.info(f"status update request raised for service {service_id}")
        return {"message": "status update request sent for approval", "service_id": service_id}
    except Exception as e:
        logging.error("status update request failed!")
        raise HTTPException(status_code=500, detail="status update request could not be sent")


@app.get("/service/my")
def my_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={"technician_alloted": user["username"]})
        logging.info(f"service dataset fetched for technician {user['username']}")
        return {"message": "my service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("technician service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/service/update_charges/{service_id}")
def update_service_charges(service_id: str, request: ServiceChargeRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail()
        db.set_service_charges(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, service_charges=request.service_charges)
        return {"message": "service charges updated", "service_id": service_id, "service_charges": request.service_charges}
    except Exception as e:
        logging.error("service charges update failed!")
        raise HTTPException(status_code=500, detail="service charges cannot be updated")


@app.post("/service/upload_media/{service_id}")
def upload_service_media(service_id: str, request: ServiceMediaRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        db = service_detail()
        db.attach_media(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, image=request.image, video=request.video)

        if request.video:
            _raise_media_review_request(service_id, user["username"])

        return {"message": "media uploaded successfully", "service_id": service_id}
    except Exception as e:
        logging.error("service media upload failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/service/request_spare_part/{service_id}")
def request_spare_part(service_id: str, request: SparePartRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        db = service_detail()
        db.request_spare_part(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, note=request.note)

        req = request_manager(
            request_type="spare_part",
            raised_by=user["username"],
            details={"service_id": service_id, "note": request.note}
        )
        req.add(collection_name=REQUESTS_COLLECTION)

        return {"message": "spare part requested successfully", "service_id": service_id}
    except Exception as e:
        logging.error("spare part request failed!")
        raise HTTPException(status_code=500, detail="spare part request failed")


@app.post("/service/manager_confirm/{service_id}")
def manager_confirm(service_id: str, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.manager_confirm_return(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        return {"message": "manager confirmed part return", "service_id": service_id}
    except Exception as e:
        logging.error("manager confirmation failed!")
        raise HTTPException(status_code=500, detail="manager confirmation failed")


@app.post("/service/extend_warranty/{service_id}")
def extend_warranty(service_id: str, request: ExtendWarrantyRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.extend_warranty(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, warranty_until=request.warranty_until)
        return {"message": "warranty extended", "service_id": service_id, "warranty_until": request.warranty_until}
    except Exception as e:
        logging.error("warranty extension failed!")
        raise HTTPException(status_code=500, detail="warranty extension failed")


@app.get("/inventory/")
def inventory(user: dict = Depends(get_current_user)):
    try:
        # serial_numbers and hologram_numbers were the bulk of this endpoint's
        # payload (measured: one lot's hologram_numbers alone was 166KB) and
        # the table doesn't render them directly — View/Edit/Repair fetch the
        # full row on demand instead (see /inventory/detail). The one thing
        # the table DOES need from hologram_numbers is its length, for the
        # spare/service parts Status badge — an aggregation $size keeps that
        # without shipping the array itself.
        col = mongodbclient().database[INVENTORY_COLLECTION]
        pipeline = [
            {"$addFields": {"hologram_count": {"$size": {"$ifNull": ["$hologram_numbers", []]}}}},
            {"$project": {"serial_numbers": 0, "hologram_numbers": 0}}
        ]
        dataset = list(col.aggregate(pipeline))
        for item in dataset:
            item["_id"] = str(item["_id"])

        # warranty entries don't flip on their own — work it out fresh on every
        # fetch by comparing today's date to the stored warranty_until.
        # Applies to any item that carries a warranty_until: service_parts
        # with part_category=="warranty", AND spare_parts (covered under the
        # product's own warranty from the shipment).
        today_dt = datetime.now(timezone.utc)
        today = today_dt.strftime("%Y-%m-%d")
        for item in dataset:
            if item.get("warranty_until"):
                item["warranty_status"] = "over warranty" if item["warranty_until"] < today else "under warranty"
                if item["warranty_status"] == "under warranty":
                    try:
                        expiry = datetime.strptime(item["warranty_until"], "%Y-%m-%d")
                        item["warranty_days_left"] = (expiry - today_dt.replace(tzinfo=None)).days
                    except ValueError:
                        item["warranty_days_left"] = None

        logging.info("inventory dataset was fetched successfully")
        return {"message": "inventory dataset", "dataset": dataset}
    except Exception as e:
        logging.error("inventory dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="inventory dataset cannot be fetched")


@app.get("/inventory/detail")
def inventory_detail(product_id: str = "", model_no: str = "", product_type: str = "",
                      user: dict = Depends(get_current_user)):
    """
    Fresh, full copy of one lot — including serial_numbers/hologram_numbers,
    which the main /inventory/ list no longer carries (they were the bulk of
    its payload). Called on demand when View/Edit/Repair is opened on a row,
    instead of relying on the (now-lighter) cached list.
    """
    try:
        # model_no is only added to the query when one was actually passed in.
        # Older lots (created before model_no existed) or model-less product
        # types store it as null/missing, not "" — querying {"model_no": ""}
        # against those wouldn't match, which is what was making this
        # endpoint 404 and silently fall back to the serial-less cached row
        # on the frontend. Matching on product_id (+ product_type) alone when
        # no model_no was given avoids that false negative.
        query = {"product_id": product_id}
        if model_no:
            query["model_no"] = model_no
        if product_type:
            query["product_type"] = product_type
        db = inventory_manager()
        docs = db.get_data(collection_name=INVENTORY_COLLECTION, query=query)
        if not docs:
            raise HTTPException(status_code=404, detail="product not found")
        item = docs[0]
        # Mongo's _id is an ObjectId, which FastAPI can't JSON-serialize on
        # its own — this was crashing the response *after* the try/except
        # below with a 500, since the crash happens during serialization,
        # not inside this function. The /inventory/ list endpoint already
        # does this same conversion; this endpoint was missing it.
        if "_id" in item:
            item["_id"] = str(item["_id"])

        today_dt = datetime.now(timezone.utc)
        today = today_dt.strftime("%Y-%m-%d")
        if item.get("warranty_until"):
            item["warranty_status"] = "over warranty" if item["warranty_until"] < today else "under warranty"
            if item["warranty_status"] == "under warranty":
                try:
                    expiry = datetime.strptime(item["warranty_until"], "%Y-%m-%d")
                    item["warranty_days_left"] = (expiry - today_dt.replace(tzinfo=None)).days
                except ValueError:
                    item["warranty_days_left"] = None

        return {"message": "product detail", "product": item}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"inventory detail cannot be fetched: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/inventory/serial_history/{serial_number}")
def serial_history(serial_number: str, user: dict = Depends(get_current_user)):
    """
    Full lifetime trail for one serial number, stitched together from every
    collection that could mention it — inventory (current stock), assembly
    (when/how it was built), orders (sold + any return), and allocations
    (demo unit or sales-person allocation + any return/damage), plus every
    service record raised against it. Returned as a single chronologically
    sorted timeline so the "Record" search on the Inventory page can show a
    unit's whole history in one place: how it entered stock, where it went,
    and what happened to it since.
    """
    try:
        # every serial is lowercased when it's first added to inventory (see
        # inventory.js), so the lookup here has to match on the same
        # lowercased value or a serial typed in with different case (as
        # printed on the unit's physical label) would silently find nothing.
        serial_number = serial_number.strip().lower()
        if not serial_number:
            raise HTTPException(status_code=400, detail="serial number is required")

        events = []

        # ---- Currently in inventory (and under which category) ----
        inv_db = inventory_manager()
        inv_entries = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"serial_numbers": serial_number})
        for entry in inv_entries:
            events.append({
                "type": "inventory",
                "label": f"In stock — {productTypeLabelPy(entry.get('product_type'))}",
                "date": entry.get("purchase_date"),
                "details": {
                    "product_name": entry.get("product_name"),
                    "product_id": entry.get("product_id"),
                    "model_no": entry.get("model_no"),
                    "supplier": entry.get("supplier"),
                    "lot_no": entry.get("lot_no"),
                    "product_type": entry.get("product_type"),
                    "reason": entry.get("reason") or None,
                }
            })

        # ---- Assembly (when/how this unit was built, if it was assembled in-house) ----
        asm_db = assembly_manager()
        assemblies = asm_db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"serials.serial_number": serial_number})
        for asm in assemblies:
            serial_entry = next((s for s in asm.get("serials", []) if s.get("serial_number") == serial_number), {})
            events.append({
                "type": "assembly",
                "label": "Assembled",
                "date": asm.get("completed_at") or asm.get("assembly_date") or asm.get("created_at"),
                "details": {
                    "assembly_id": asm.get("assembly_id"),
                    "product_name": asm.get("product_name"),
                    "hologram_number": serial_entry.get("hologram_number"),
                    "status": asm.get("status"),
                }
            })

        # ---- Orders (sale + any return) ----
        order_db = order_manager()
        orders = order_db.get_data(collection_name=ORDERS_COLLECTION, query={"items.serial_numbers": serial_number})
        for o in orders:
            item = next((it for it in o.get("items", []) if serial_number in (it.get("serial_numbers") or [])), {})
            events.append({
                "type": "order",
                "label": "Sold via order",
                "date": o.get("order_date"),
                "details": {
                    "order_id": o.get("order_id"),
                    "product_name": item.get("product_name"),
                    "company_name": (o.get("customer") or {}).get("company_name"),
                    "status": o.get("status"),
                }
            })
            if o.get("status") == "returned":
                ret_item = next((r for r in (o.get("returned_items") or []) if serial_number in (r.get("serial_numbers") or [])), None)
                events.append({
                    "type": "order_return",
                    "label": "Returned (order)",
                    "date": o.get("return_date") or o.get("order_date"),
                    "details": {
                        "order_id": o.get("order_id"),
                        "reason": o.get("return_reason"),
                        "condition": ret_item.get("condition") if ret_item else None,
                    }
                })

        # ---- Allocations (demo unit or sales-person product allocation + return/damage) ----
        alloc_db = allocation_manager()
        allocations = alloc_db.get_data(collection_name=ALLOCATION_COLLECTION, query={"items.serial_numbers": serial_number})
        for a in allocations:
            item = next((it for it in a.get("items", []) if serial_number in (it.get("serial_numbers") or [])), {})
            is_demo = a.get("allocation_type") == "demo_unit"
            events.append({
                "type": "allocation",
                "label": "Allocated to demo/customer" if is_demo else "Allocated to sales person",
                "date": a.get("allotment_date"),
                "details": {
                    "allocation_id": a.get("allocation_id"),
                    "product_name": item.get("product_name"),
                    "to": (a.get("customer") or {}).get("company_name") if is_demo else (a.get("sales_person") or {}).get("name"),
                    "allocated_by": a.get("allocated_by"),
                    "return_status": a.get("return_status"),
                }
            })
            if a.get("return_status") == "returned":
                damage = a.get("damage_report") or {}
                events.append({
                    "type": "allocation_return",
                    "label": "Returned (allocation)" + (" — faulty" if damage.get("reported") else ""),
                    "date": a.get("return_completed_at") or a.get("returned_on"),
                    "details": {
                        "allocation_id": a.get("allocation_id"),
                        "returned_by": a.get("returned_by"),
                        "faulty": bool(damage.get("reported")),
                        "issue": damage.get("issue"),
                    }
                })

        # ---- Service records raised against this serial ----
        svc_db = service_detail(product_id="", serial_no="")
        services = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"serial_no": serial_number})
        for s in services:
            events.append({
                "type": "service",
                "label": f"Service — {s.get('service_status', 'raised')}",
                "date": s.get("created_at") or s.get("purchase_date"),
                "details": {
                    "service_id": s.get("service_id"),
                    "issue": s.get("issue"),
                    "status": s.get("service_status"),
                    "technician_id": s.get("technician_id"),
                }
            })

        # dates can come back as plain "YYYY-MM-DD" strings from some
        # collections and as native datetime objects from others — sorting
        # a mix of the two raises a TypeError ("'<' not supported between
        # instances of 'datetime.datetime' and 'str'"), which was another
        # way this endpoint could 500. Stringify every date before sorting.
        events.sort(key=lambda e: str(e.get("date") or ""))
        for e in events:
            if e.get("date") is not None and not isinstance(e["date"], str):
                e["date"] = str(e["date"])

        logging.info(f"serial history fetched for {serial_number}: {len(events)} event(s)")
        return {"message": "serial history", "serial_number": serial_number, "events": events}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"serial history lookup failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def productTypeLabelPy(product_type):
    labels = {"product": "Product", "accessories": "Accessory", "spare_parts": "Spare Part",
              "service_parts": "Service Part", "damaged": "Damaged Product"}
    return labels.get(product_type, product_type or "Product")


@app.get("/inventory/available_serials")
def available_serials(product_id: str, model_no: str = "", user: dict = Depends(require_role("admin", "accounts"))):
    """
    Lists every serial number currently on file for product_id (scoped to
    model_no when one is given), oldest lot first — same order the allocator
    uses. Powers the order review step's serial-number picker: the first
    `quantity` entries are what auto-allocation would pick by default, and the
    full list is what's available to switch to instead.
    """
    try:
        db = inventory_manager()
        serials = db.list_available_serials(INVENTORY_COLLECTION, product_id, model_no=model_no or None)
        return {"message": "available serial numbers", "serial_numbers": serials}
    except Exception as e:
        logging.error("fetching available serial numbers failed!")
        raise HTTPException(status_code=500, detail="available serial numbers cannot be fetched")


@app.post("/inventory/create")
def create_inventory(request: InventoryRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        # serial numbers are optional for accessories / spare_parts / service_parts —
        # only enforce the quantity match when at least one serial number was actually given
        serial_optional_types = ("accessories", "spare_parts", "service_parts")
        serials_required = request.product_type not in serial_optional_types or len(request.serial_numbers) > 0
        if serials_required and len(request.serial_numbers) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match quantity")
        if len(set(request.serial_numbers)) != len(request.serial_numbers):
            raise HTTPException(status_code=400, detail="serial numbers must be unique")

        if request.product_type in ("spare_parts", "service_parts"):
            if not request.parent_product_name.strip():
                raise HTTPException(status_code=400, detail="product name (the part belongs to) is required")
            if request.product_type == "service_parts" and request.part_category not in ("purchase", "warranty"):
                raise HTTPException(status_code=400, detail="select purchase or warranty for a service part")
            holograms = [h.strip() for h in request.hologram_numbers if h and h.strip()]
            if len(set(holograms)) != len(holograms):
                raise HTTPException(status_code=400, detail="hologram numbers must be unique")
            if len(holograms) > request.quantity:
                raise HTTPException(status_code=400, detail="hologram numbers cannot outnumber the quantity")
            if holograms:
                taken = inventory_manager().get_data(collection_name=INVENTORY_COLLECTION,
                                                     query={"hologram_numbers": {"$in": holograms}})
                if taken:
                    used = sorted({h for t in taken for h in (t.get("hologram_numbers") or []) if h in holograms})
                    raise HTTPException(status_code=400, detail=f"hologram number(s) already on file: {', '.join(used)}")
            part = inventory_manager(
                product_name=request.product_name.strip(),
                quantity=request.quantity,
                purchase_date=request.purchase_date,
                lot_no=request.lot_no,
                supplier=request.supplier,
                supplier_address=request.supplier_address,
                price=request.price or 0,
                tax_rate=request.tax_rate,
                product_type=request.product_type,
                warranty_until=request.warranty_until,
                parent_product_name=request.parent_product_name.strip(),
                part_category=request.part_category if request.product_type == "service_parts" else None,
                hologram_numbers=holograms,
            )
            part.add_part(collection_name=INVENTORY_COLLECTION)
            return {"message": "part was listed successfully"}

        inventory_item = inventory_manager(
            product_name=request.product_name,
            product_id=request.product_id,
            quantity=request.quantity,
            purchase_date=request.purchase_date,
            lot_no=request.lot_no,
            supplier=request.supplier,
            price=request.price,
            tax_rate=request.tax_rate,
            model_no=request.model_no,
            supplier_address=request.supplier_address,
            serial_numbers=request.serial_numbers,
            product_type=request.product_type,
            warranty_until=(request.warranty_until or None) if request.product_type == "damaged" else None,
            reason=request.reason if request.product_type == "damaged" else ""
        )
        inventory_item.add_or_merge(collection_name=INVENTORY_COLLECTION)
        logging.info("product listed successfully on inventory")
        return {"message": "product was listed successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("product cannot be listed to the inventory")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/inventory/update/{product_id}")
def update_inventory(product_id: str, request: InventoryUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = inventory_manager()
        match_query = {"product_id": product_id}
        if request.model_no is not None:
            match_query["model_no"] = request.model_no
        existing = db.get_data(collection_name=INVENTORY_COLLECTION, query=match_query)
        if not existing:
            raise HTTPException(status_code=404, detail="product not found")
        current_serials = existing[0].get("serial_numbers") or []
        current_type = existing[0].get("product_type", "product")

        updated_values = dict(request.updated_values)
        raw_effective_type = updated_values.get("product_type", current_type)
        # normalize (lowercase + strip) so a stray case/whitespace mismatch — or a
        # request that omits product_type — can never make an accessories/spare_parts/
        # service_parts lot fall through to the strict "quantity must equal serial
        # count" check below. Falls back to the type already on file if the request's
        # value doesn't normalize to anything meaningful.
        effective_type = (str(raw_effective_type or "").strip().lower()) or str(current_type or "product").strip().lower()

        SERIAL_OPTIONAL_TYPES = ("accessories", "spare_parts", "service_parts")

        # Both a straight removal (write-off, gone from stock entirely) and a
        # "mark faulty" (pulled off this lot but pushed into the Damaged
        # Product category instead of discarded — handled further down)
        # take the unit off THIS lot the same way, so they're combined here
        # for that part. Kept as two separate request fields so the faulty
        # ones can still be told apart afterwards for the damaged-category push.
        pulled_off_serials = set(request.remove_serial_numbers or []) | set(request.faulty_serial_numbers or [])

        # serial numbers are optional for accessories / spare_parts / service_parts,
        # so quantity is free to move independently of the serial list for those
        # types — only sync serials with quantity for product/damaged
        if effective_type in SERIAL_OPTIONAL_TYPES or str(current_type or "").strip().lower() in SERIAL_OPTIONAL_TYPES:
            if request.new_serial_numbers:
                if len(set(request.new_serial_numbers)) != len(request.new_serial_numbers):
                    raise HTTPException(status_code=400, detail="new serial numbers must be unique")
                duplicates = [s for s in request.new_serial_numbers if s in current_serials]
                if duplicates:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) already exist on this product: {', '.join(duplicates)}")
            serials = list(current_serials)
            if pulled_off_serials:
                serials = [s for s in serials if s not in pulled_off_serials]
            if request.new_serial_numbers:
                serials = serials + request.new_serial_numbers
            if pulled_off_serials or request.new_serial_numbers:
                updated_values["serial_numbers"] = serials

        # whenever quantity changes, keep serial_numbers in sync instead of letting
        # them silently drift out of step with the stock count
        elif "quantity" in updated_values and updated_values["quantity"] is not None:
            new_quantity = int(updated_values["quantity"])
            serials = list(current_serials)

            if pulled_off_serials:
                missing = [s for s in pulled_off_serials if s not in serials]
                if missing:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) not found on this product: {', '.join(missing)}")
                serials = [s for s in serials if s not in pulled_off_serials]

            if request.new_serial_numbers:
                if len(set(request.new_serial_numbers)) != len(request.new_serial_numbers):
                    raise HTTPException(status_code=400, detail="new serial numbers must be unique")
                duplicates = [s for s in request.new_serial_numbers if s in serials]
                if duplicates:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) already exist on this product: {', '.join(duplicates)}")
                serials = serials + request.new_serial_numbers

            if len(serials) != new_quantity:
                if new_quantity > len(serials):
                    raise HTTPException(
                        status_code=400,
                        detail=f"quantity is {new_quantity} but only {len(serials)} serial number(s) provided — "
                               f"add {new_quantity - len(serials)} more serial number(s)"
                    )
                raise HTTPException(
                    status_code=400,
                    detail=f"quantity is {new_quantity} but {len(serials)} serial number(s) are on file — "
                           f"remove {len(serials) - new_quantity} serial number(s)"
                )

            updated_values["serial_numbers"] = serials

        # hologram numbers are tracked per-unit (one per quantity) for spare_parts /
        # service_parts, separate from serial numbers. Each is added up to however many
        # slots remain (quantity - hologram numbers already on file); anything beyond
        # that is handed back as "leftover" so the caller can show a popup and let the
        # user export the unused ones instead of silently dropping or over-filling.
        hologram_added = 0
        hologram_leftover: list[str] = []
        if effective_type in ("spare_parts", "service_parts") and (
            request.new_hologram_numbers or request.remove_hologram_numbers or "quantity" in updated_values
        ):
            current_hologram = existing[0].get("hologram_numbers")
            if current_hologram is None:
                legacy = existing[0].get("hologram_no")
                current_hologram = [legacy] if legacy else []
            else:
                current_hologram = list(current_hologram)

            if request.remove_hologram_numbers:
                current_hologram = [h for h in current_hologram if h not in request.remove_hologram_numbers]

            if request.new_hologram_numbers:
                incoming = [h.strip() for h in request.new_hologram_numbers if h and h.strip()]
                if len(set(incoming)) != len(incoming):
                    raise HTTPException(status_code=400, detail="uploaded hologram numbers contain duplicates")
                dup = [h for h in incoming if h in current_hologram]
                if dup:
                    raise HTTPException(status_code=400,
                                         detail=f"hologram number(s) already on file: {', '.join(dup)}")
                effective_quantity = int(updated_values.get("quantity", existing[0].get("quantity", 0)) or 0)
                remaining_slots = max(0, effective_quantity - len(current_hologram))
                to_add = incoming[:remaining_slots]
                hologram_leftover = incoming[remaining_slots:]
                hologram_added = len(to_add)
                current_hologram = current_hologram + to_add

            # never let hologram numbers on file outnumber the quantity (e.g. quantity
            # was reduced) — trim from the end rather than leaving a stale mismatch
            effective_quantity = int(updated_values.get("quantity", existing[0].get("quantity", 0)) or 0)
            if len(current_hologram) > effective_quantity:
                current_hologram = current_hologram[:effective_quantity]

            updated_values["hologram_numbers"] = current_hologram
            updated_values.pop("hologram_no", None)  # migrated to hologram_numbers list

        # Faulty units pulled off this lot (folded into pulled_off_serials
        # above, alongside plain removals) get pushed into the Damaged
        # Product category instead of just being discarded — merges into an
        # existing damaged entry for the same product_id+model_no, or
        # creates one, same pattern used when an order return comes back
        # faulty. Uses the lot's ORIGINAL product_id/product_name/model_no
        # (from `existing`, before this same request's own rename, if any) —
        # these are the exact physical units that were on file under that
        # identity.
        if request.faulty_serial_numbers:
            src_product_id = existing[0].get("product_id", product_id)
            src_product_name = existing[0].get("product_name", "")
            src_model_no = existing[0].get("model_no", "") or ""
            damage_reason = "marked faulty during inventory edit"
            existing_damaged = db.get_data(
                collection_name=INVENTORY_COLLECTION,
                query={"product_id": src_product_id, "model_no": src_model_no, "product_type": "damaged"}
            )
            if existing_damaged:
                entry = existing_damaged[0]
                merged_serials = (entry.get("serial_numbers") or []) + list(request.faulty_serial_numbers)
                new_damaged_quantity = int(entry.get("quantity", 0) or 0) + len(request.faulty_serial_numbers)
                db.update(
                    collection_name=INVENTORY_COLLECTION,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": merged_serials, "quantity": new_damaged_quantity, "reason": damage_reason}
                )
            else:
                inventory_manager(
                    product_name=src_product_name,
                    product_id=src_product_id,
                    quantity=len(request.faulty_serial_numbers),
                    model_no=src_model_no,
                    serial_numbers=list(request.faulty_serial_numbers),
                    product_type="damaged",
                    reason=damage_reason,
                ).add(collection_name=INVENTORY_COLLECTION)

        db.update(collection_name=INVENTORY_COLLECTION, query=match_query,
                   update_values=updated_values)
        logging.info("inventory was updated")
        return {
            "message": "inventory was updated successfully",
            "product_id": product_id,
            "hologram_added": hologram_added,
            "hologram_leftover": hologram_leftover
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="inventory cannot be updated")


@app.post("/inventory/delete/{product_id}")
def delete_product(product_id: str, model_no: Optional[str] = None, user: dict = Depends(require_role("admin"))):
    try:
        db = inventory_manager(product_id=product_id)
        if model_no is not None:
            existing = db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_id": product_id, "model_no": model_no})
            if not existing:
                raise HTTPException(status_code=404, detail="product not found")
            db.delete_data(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(existing[0]["_id"])})
        else:
            db.delete(collection_name=INVENTORY_COLLECTION)
        logging.info(f"product was deleted successfully from the inventory {product_id}")
        return {"message": "product deletion was successful", "product_id": product_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("product deletion was failed!")
        raise HTTPException(status_code=500, detail="product cannot be deleted")


@app.post("/inventory/repair/{product_id}")
def repair_damaged_product(product_id: str, model_no: Optional[str] = None, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    """Action button on the Damaged Product row (replaces Delete there).

    - If the damaged entry is a full PRODUCT (it carries serial numbers,
      just like a normal product entry) -> a new service record is opened
      for it with issue="Inhouse Warranty", so it flows into the Service
      page for in-house repair tracking.
    - If it's a PART (no serial numbers - e.g. one swapped out during a
      service and filed as damaged via its hologram number) -> it isn't
      serviceable in-house, so it's simply flagged in the damaged row's
      Status column as "Send to Parent Company" instead.
    """
    try:
        db = inventory_manager()
        match_query = {"product_id": product_id, "product_type": "damaged"}
        if model_no is not None:
            match_query["model_no"] = model_no
        existing = db.get_data(collection_name=INVENTORY_COLLECTION, query=match_query)
        if not existing:
            raise HTTPException(status_code=404, detail="damaged product not found")
        item = existing[0]

        is_product = bool(item.get("serial_numbers"))

        if is_product:
            serial_no = item["serial_numbers"][0] if item.get("serial_numbers") else ""
            svc = service_detail(product_id=item.get("product_id", ""), serial_no=serial_no)
            svc.add_service(
                collection_name=SERVICE_COLLECTION,
                technician_id="",
                purchase_date=item.get("purchase_date", ""),
                issue="Inhouse Warranty",
                image="",
                video="",
                location="indoor",
                spare_parts="",
            )
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(item["_id"])},
                      update_values={"damage_status": "Sent for Repair (Inhouse Warranty)"})
            logging.info(f"damaged product {product_id} sent for in-house repair, service {svc.service_id} created")
            return {"message": "sent for in-house warranty repair", "mode": "product", "service_id": svc.service_id}
        else:
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(item["_id"])},
                      update_values={"damage_status": "Send to Parent Company"})
            logging.info(f"damaged part {product_id} marked to send to parent company")
            return {"message": "marked to send to parent company", "mode": "part"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("repair action on damaged product failed!")
        raise HTTPException(status_code=500, detail="repair action failed")


@app.get("/customer/")
def customers(user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        if user["role"] in ("admin", "accounts"):
            dataset = db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
        elif user["role"] == "distributor":
            acc_db = login()
            team = acc_db.get_data(ACCOUNTS_COLLECTION, query={"role": "distributor", "manager": user["username"]})
            visible_usernames = [user["username"]] + [m["username"] for m in team]
            dataset = db.get_data(collection_name=CUSTOMER_COLLECTION, query={"created_by": {"$in": visible_usernames}})
        else:
            dataset = []
        logging.info("customer dataset was fetched successfully")
        return {"message": "customer dataset", "dataset": dataset}
    except Exception as e:
        logging.error("customer dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="customer dataset cannot be fetched")


@app.get("/customer/search")
def search_customer(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        dataset = db.search(collection_name=CUSTOMER_COLLECTION, term=term) if term else db.get_data(CUSTOMER_COLLECTION, query={})
        if user["role"] == "distributor":
            # a distributor should only see customers they themselves created —
            # not customers created by other salespeople on their team
            dataset = [c for c in dataset if c.get("created_by") == user["username"]]
        return {"message": "customer search results", "dataset": dataset}
    except Exception as e:
        logging.error("customer search failed")
        raise HTTPException(status_code=500, detail="customer search failed")


@app.post("/customer/create")
def create_customer(request: CustomerRequest, user: dict = Depends(require_role("admin", "accounts", "distributor"))):
    try:
        new_customer = customer_manager(
            company_name=request.company_name,
            company_address=request.company_address,
            gst_number=request.gst_number,
            contractor_person=request.contractor_person,
            contractor_number=request.contractor_number,
            contractor_email=request.contractor_email,
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)

        customer_db = customer_manager()
        customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                 update_values={"credit_limit": request.credit_limit, "credit_used": 0, "created_by": user["username"]})

        logging.info("customer created successfully")
        return {
            "message": "customer created successfully",
            "customer_id": new_customer.customer_id,
            "customer": {
                "customer_id": new_customer.customer_id,
                "company_name": new_customer.company_name,
                "company_address": new_customer.company_address,
                "gst_number": new_customer.gst_number,
                "contractor_person": new_customer.contractor_person,
                "contractor_number": new_customer.contractor_number,
                "contractor_email": new_customer.contractor_email,
                "credit_limit": request.credit_limit,
                "credit_used": 0,
                "created_by": user["username"],
            }
        }
    except Exception as e:
        logging.error("customer creation failed!")
        raise HTTPException(status_code=500, detail="customer creation failed")


@app.post("/customer/update/{customer_id}")
def update_customer(customer_id: str, request: CustomerUpdateRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = customer_manager()
        result = db.update(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id},
                            update_values=request.updated_values)
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="no customer found with this id")
        logging.info("customer was updated")
        return {"message": "customer updated successfully", "customer_id": customer_id,
                "updated_value": request.updated_values}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("customer updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="customer cannot be updated")


@app.post("/customer/delete/{customer_id}")
def delete_customer(customer_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = customer_manager()
        db.delete(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        logging.info(f"customer was deleted successfully {customer_id}")
        return {"message": "customer deletion was successful", "customer_id": customer_id}
    except Exception as e:
        logging.error("customer deletion was failed!")
        raise HTTPException(status_code=500, detail="customer cannot be deleted")


@app.get("/salesperson/search")
def search_salesperson(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = sales_person_manager()
        dataset = db.search(collection_name=SALESPERSON_COLLECTION, term=term) if term else db.get_data(SALESPERSON_COLLECTION, query={})
        return {"message": "sales person search results", "dataset": dataset}
    except Exception as e:
        logging.error("sales person search failed")
        raise HTTPException(status_code=500, detail="sales person search failed")


@app.post("/salesperson/create")
def create_salesperson(request: SalesPersonRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        new_sp = sales_person_manager(
            name=request.name,
            company_name=request.company_name,
            address=request.address,
            contact_number=request.contact_number,
            email=request.email,
        )
        new_sp.add(collection_name=SALESPERSON_COLLECTION)
        return {
            "message": "sales person created successfully",
            "sales_person_id": new_sp.sales_person_id,
            "sales_person": {
                "sales_person_id": new_sp.sales_person_id,
                "name": new_sp.name,
                "company_name": new_sp.company_name,
                "address": new_sp.address,
                "contact_number": new_sp.contact_number,
                "email": new_sp.email,
            }
        }
    except Exception as e:
        logging.error("sales person creation failed!")
        raise HTTPException(status_code=500, detail="sales person creation failed")


@app.get("/service/active")
def active_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION,
                                       query={"status": {"$in": ["active", "in_progress"]}})
        return {"message": "active services", "dataset": dataset}
    except Exception as e:
        logging.error("fetching active services failed")
        raise HTTPException(status_code=500, detail="active services cannot be fetched")


@app.get("/service/available_hologram_parts")
def available_hologram_parts(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    """
    Powers the "Update Status" -> Completed -> spare part swap form on the
    Service page: instead of letting the technician type a free-text new
    hologram number (which can typo/mismatch what's actually on file and
    silently create bad inventory data), this returns every service_parts
    entry that actually carries hologram numbers on file, grouped by part
    name, so the UI can offer a plain pick-list instead.
    """
    try:
        inv_db = inventory_manager()
        entries = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_type": "service_parts"})
        pool = {}
        for entry in entries:
            holograms = entry.get("hologram_numbers") or []
            if not holograms:
                continue
            name = entry.get("product_name", "")
            if not name:
                continue
            pool.setdefault(name, set()).update(holograms)
        dataset = [{"part_name": name, "hologram_numbers": sorted(numbers)} for name, numbers in pool.items() if numbers]
        dataset.sort(key=lambda p: p["part_name"].lower())
        return {"message": "available hologram-tagged service parts", "dataset": dataset}
    except Exception as e:
        logging.error("fetching available hologram parts failed!")
        raise HTTPException(status_code=500, detail="could not fetch available hologram parts")


@app.get("/allocation/")
def allocations(user: dict = Depends(get_current_user)):
    try:
        run_in_background("purge_damage_images", purge_stale_damage_images)
        db = allocation_manager()
        # damage photos are base64 blobs — fetched on demand via /allocation/{id}/damage_image
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION, query={}, projection={"damage_report.image": 0})
        return {"message": "allocation dataset", "dataset": dataset}
    except Exception as e:
        logging.error("fetching allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


@app.post("/allocation/send_to_dispatch/{allocation_id}")
def send_allocation_to_dispatch(allocation_id: str, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        allocation = matches[0]

        if allocation.get("allocation_type") == "spare_part":
            raise HTTPException(status_code=400, detail="spare part allocations already appear in the dispatch queue automatically")
        if allocation.get("dispatch"):
            raise HTTPException(status_code=400, detail="this allocation has already been dispatched")
        if allocation.get("sent_to_dispatch"):
            raise HTTPException(status_code=400, detail="this allocation is already in the dispatch queue")

        db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"sent_to_dispatch": True})
        logging.info(f"allocation {allocation_id} sent to dispatch queue")
        return {"message": "allocation sent to dispatch queue", "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("sending allocation to dispatch failed")
        raise HTTPException(status_code=500, detail="could not send allocation to dispatch")


@app.post("/allocation/report_damage/{allocation_id}")
def report_damage(allocation_id: str, request: DamageReportRequest, user: dict = Depends(require_role("admin", "accounts", "distributor", "service_manager"))):
    try:
        if not request.image:
            raise HTTPException(status_code=400, detail="a photo of the damaged product is required")
        if not request.issue or not request.issue.strip():
            raise HTTPException(status_code=400, detail="please specify the issue")

        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")

        allocation = matches[0]
        is_spare = allocation.get("allocation_type") == "spare_part"
        product_label = (
            f"{allocation.get('spare_part', {}).get('part_name', '')}"
            if is_spare else
            ", ".join(f"{i.get('product_name')} x{i.get('quantity')}" for i in allocation.get("items", []))
        )

        reported_at = datetime.now(timezone.utc).isoformat()
        email_sent = send_damage_report_email(
            allocation_id=allocation_id,
            product_label=product_label,
            issue=request.issue,
            image_data_url=request.image,
            reported_by=user["username"]
        )

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={
                "damage_report": {
                    "reported": True,
                    "issue": request.issue,
                    "image": request.image,
                    "image_purged": False,
                    "reported_by": user["username"],
                    "reported_at": reported_at,
                    "email_sent": email_sent
                }
            }
        )

        logging.info(f"damage reported for allocation {allocation_id} by {user['username']}")
        return {"message": "damage reported successfully", "allocation_id": allocation_id, "email_sent": email_sent}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"reporting damage failed: {e}")
        raise HTTPException(status_code=500, detail="damage report could not be saved")


@app.get("/allocation/{allocation_id}/damage_image")
def allocation_damage_image(allocation_id: str, user: dict = Depends(get_current_user)):
    try:
        docs = allocation_manager().get_data(collection_name=ALLOCATION_COLLECTION,
                                             query={"allocation_id": allocation_id},
                                             projection={"damage_report.image": 1})
        image = ((docs[0].get("damage_report") or {}).get("image")) if docs else None
        return {"image": image}
    except Exception:
        logging.error("fetching damage image failed")
        raise HTTPException(status_code=500, detail="damage image cannot be fetched")


@app.get("/allocation/mine")
def my_allocations(user: dict = Depends(require_role("distributor"))):
    try:
        db = allocation_manager()
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION,
                               query={"allocation_type": "demo_unit", "allocated_by": user["username"]},
                               projection={"damage_report.image": 0})
        return {"message": "my demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


def _fulfill_demo_unit(customer_id: str, customer: dict, items: list, allocated_by: str):
    """Resolves/creates the customer, deducts stock + serials from inventory, and records
    the demo_unit allocation. Shared by the direct admin/accounts endpoint and by
    /request/approve/{request_id} when a distributor's request is approved."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product")

    customer_db = customer_manager()
    customer_snapshot = dict(customer or {})

    if customer_id:
        existing = customer_db.get_data(CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not existing:
            raise HTTPException(status_code=404, detail="selected customer not found")
        customer_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
    else:
        if not customer_snapshot.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        new_customer = customer_manager(
            company_name=customer_snapshot.get("company_name"),
            company_address=customer_snapshot.get("company_address"),
            gst_number=customer_snapshot.get("gst_number"),
            contractor_person=customer_snapshot.get("contractor_person"),
            contractor_number=customer_snapshot.get("contractor_number"),
            contractor_email=customer_snapshot.get("contractor_email"),
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)
        customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                 update_values={"created_by": allocated_by})
        customer_snapshot = {
            "customer_id": new_customer.customer_id,
            "company_name": new_customer.company_name,
            "company_address": new_customer.company_address,
            "gst_number": new_customer.gst_number,
            "contractor_person": new_customer.contractor_person,
            "contractor_number": new_customer.contractor_number,
            "contractor_email": new_customer.contractor_email,
            "created_by": allocated_by,
        }

    inventory_db = inventory_manager()
    for item in items:
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item["product_id"])
        if available < item["quantity"]:
            raise HTTPException(status_code=400, detail=f"insufficient stock for {item['product_name']}: only {available} available")

    demo_items = []
    for item in items:
        allocated_serials = inventory_db.allocate_units(
            collection_name=INVENTORY_COLLECTION, product_id=item["product_id"], quantity=item["quantity"]
        )
        demo_items.append({
            "product_id": item["product_id"],
            "product_name": item["product_name"],
            "quantity": item["quantity"],
            "serial_numbers": allocated_serials
        })

    allocation = allocation_manager(customer=customer_snapshot, items=demo_items, allocated_by=allocated_by)
    allocation.add(collection_name=ALLOCATION_COLLECTION)
    logging.info(f"demo unit allocation {allocation.allocation_id} created for {allocated_by}")
    return allocation.allocation_id


def _user_snapshot(username: str) -> dict:
    """Snapshot of a registered system user, stored on allocations as `sales_person`."""
    acc = mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
    if not acc:
        raise HTTPException(status_code=404, detail=f"user '{username}' not found")
    acc = acc[0]
    return {
        "sales_person_id": acc.get("username"),
        "username": acc.get("username"),
        "name": acc.get("name") or acc.get("username"),
        "role": acc.get("role"),
        "company_name": acc.get("company_name", ""),
        "address": "",
        "contact_number": acc.get("phone", ""),
        "email": acc.get("email", ""),
    }


def _fulfill_demo_request(items: list, requester: str, remarks: str, request_id: str):
    """Approved demo request: deduct stock and allocate straight to the requesting user.
    No customer/company details at this stage. One allocation document per unit."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product")
    snapshot = _user_snapshot(requester)
    inventory_db = inventory_manager()

    need = {}
    for item in items:
        key = (item["product_id"], item.get("model_no") or "")
        need[key] = need.get(key, 0) + item["quantity"]
    for (pid, model_no), qty in need.items():
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, pid, model_no=model_no or None)
        if available < qty:
            name = next((i["product_name"] for i in items if i["product_id"] == pid), pid)
            raise HTTPException(status_code=400, detail=f"insufficient stock for {name}: only {available} available")

    ids = []
    for item in items:
        serials = inventory_db.allocate_units(
            collection_name=INVENTORY_COLLECTION, product_id=item["product_id"],
            quantity=item["quantity"], model_no=item.get("model_no") or None)
        for i in range(item["quantity"]):
            serial = serials[i] if i < len(serials) else None
            alloc = allocation_manager(
                sales_person=snapshot,
                items=[{"product_id": item["product_id"], "product_name": item["product_name"],
                        "model_no": item.get("model_no", ""), "quantity": 1,
                        "serial_numbers": [serial] if serial else []}],
                allocated_by=requester, allocation_type="demo_unit",
                request_id=request_id, remarks=remarks)
            alloc.add(collection_name=ALLOCATION_COLLECTION)
            ids.append(alloc.allocation_id)
    logging.info(f"demo request {request_id} allocated to {requester}: {ids}")
    return ids


@app.post("/allocation/create_demo_unit")
def create_demo_unit_allocation(request: CreateDemoUnitRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        allocation_id = _fulfill_demo_unit(
            customer_id=request.customer_id,
            customer=request.customer,
            items=[item.dict() for item in request.items],
            allocated_by=user["username"]
        )
        return {"message": "demo unit allotted successfully", "allocation_id": allocation_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("demo unit allocation failed!")
        raise HTTPException(status_code=500, detail="demo unit allocation failed")


class DemoUnitRequestModel(BaseModel):
    items: list[AllocationItem]
    remarks: str = ""


class ServiceRequestModel(BaseModel):
    product_id: str
    serial_no: str
    purchase_date: str
    issue: str
    image: str = ""
    video: str = ""
    location: str = "indoor"
    spare_parts: str = ""


class SparePartRequestFlagModel(BaseModel):
    service_id: str
    note: str


class OrderRequestModel(BaseModel):
    customer_id: str = ""
    customer: dict = {}
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}
    discount: float = 0


class RequestRejectModel(BaseModel):
    reason: str = ""


class RequestApproveModel(BaseModel):
    # only used when approving a convert_to_order request
    invoice_no: str = ""
    invoice_date: str = ""


class ReturnRequestModel(BaseModel):
    returned_through: str                 # courier / transport / person name etc.
    proof: dict = {}                      # optional: {"name": str, "type": str, "data": "<data URL>"}


class ConvertToOrderRequest(BaseModel):
    company_name: str
    company_address: str
    gst_number: str = ""
    price: float
    tax_rate: float = 0


@app.post("/request/demo_unit")
def raise_demo_unit_request(request: DemoUnitRequestModel, user: dict = Depends(require_role("distributor"))):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product")

        req = request_manager(
            request_type="demo_unit",
            raised_by=user["username"],
            details={
                "items": [item.dict() for item in request.items],
                "remarks": (request.remarks or "").strip()
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "request raised successfully, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising demo unit request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.post("/allocation/convert_to_order/{allocation_id}")
def convert_demo_to_order(allocation_id: str, request: ConvertToOrderRequest, user: dict = Depends(require_role("distributor"))):
    """Distributor asks to turn a dispatched demo unit into an order. Raises an approval request."""
    try:
        if not request.company_name.strip() or not request.company_address.strip():
            raise HTTPException(status_code=400, detail="company name and address are required")
        if request.price <= 0:
            raise HTTPException(status_code=400, detail="enter a valid price")

        adb = allocation_manager()
        matches = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="demo unit not found")
        alloc = matches[0]
        if alloc.get("allocation_type") != "demo_unit" or alloc.get("allocated_by") != user["username"]:
            raise HTTPException(status_code=403, detail="this is not your demo unit")
        if not alloc.get("dispatch"):
            raise HTTPException(status_code=400, detail="only dispatched demo units can be converted to an order")
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this demo unit was already returned")
        if (alloc.get("convert_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="an order request is already pending for this demo unit")
        if (alloc.get("return_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="a return request is pending for this demo unit")

        customer = {
            "company_name": request.company_name.strip(),
            "company_address": request.company_address.strip(),
            "gst_number": request.gst_number.strip(),
        }
        items = [{
            "product_id": i.get("product_id"), "product_name": i.get("product_name"),
            "model_no": i.get("model_no", ""), "serial_numbers": i.get("serial_numbers", []),
            "quantity": i.get("quantity", 1), "price": request.price, "tax_rate": request.tax_rate
        } for i in alloc.get("items", [])]

        req = request_manager(
            request_type="convert_to_order",
            raised_by=user["username"],
            details={"allocation_id": allocation_id, "customer": customer, "items": items,
                     "price": request.price, "tax_rate": request.tax_rate}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        adb.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"convert_request": {"request_id": req.request_id, "status": "pending",
                                                           "price": request.price, "tax_rate": request.tax_rate,
                                                           "customer": customer}})
        return {"message": "order request sent for approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"convert to order request failed! {e}")
        raise HTTPException(status_code=500, detail="order request could not be raised")


@app.post("/allocation/return_request/{allocation_id}")
def raise_demo_return_request(allocation_id: str, request: ReturnRequestModel, user: dict = Depends(require_role("distributor"))):
    """Distributor reports a dispatched demo unit as returned; it is marked returned once approved."""
    try:
        through = request.returned_through.strip()
        if not through:
            raise HTTPException(status_code=400, detail="enter who/what the unit was returned through")

        proof = {}
        if request.proof and request.proof.get("data"):
            data = str(request.proof.get("data"))
            if len(data) > 2_500_000:          # ~1.8 MB file once base64-encoded
                raise HTTPException(status_code=400, detail="proof file is too large (max 1.5 MB)")
            if not data.startswith(("data:image/", "data:application/pdf")):
                raise HTTPException(status_code=400, detail="proof must be an image or a PDF")
            proof = {"name": str(request.proof.get("name", "proof"))[:120], "type": request.proof.get("type", ""), "data": data}

        adb = allocation_manager()
        matches = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="demo unit not found")
        alloc = matches[0]
        if alloc.get("allocation_type") != "demo_unit" or alloc.get("allocated_by") != user["username"]:
            raise HTTPException(status_code=403, detail="this is not your demo unit")
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this demo unit was already returned")
        if not alloc.get("dispatch"):
            raise HTTPException(status_code=400, detail="only dispatched demo units can be returned")
        if (alloc.get("return_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="a return request is already pending for this demo unit")
        if (alloc.get("convert_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="an order request is pending for this demo unit")

        req = request_manager(
            request_type="return_demo",
            raised_by=user["username"],
            details={"allocation_id": allocation_id, "returned_through": through,
                     "items": alloc.get("items", []), "proof": proof}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        adb.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"return_request": {"request_id": req.request_id, "status": "pending",
                                                          "returned_through": through, "has_proof": bool(proof)}})
        return {"message": "return request sent for approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"return request failed! {e}")
        raise HTTPException(status_code=500, detail="return request could not be raised")


def _convert_demo_to_order(alloc: dict, details: dict, raised_by: str, approver: str, invoice_no: str, invoice_date: str):
    """Moves an approved demo unit into Orders: same products/serials/company/price, dispatch info
    carried over (with the entered invoice details), and the allocation entry is removed.
    Stock is NOT touched — the units were already deducted when the demo was allotted."""
    cust = dict(details.get("customer") or {})
    new_customer = customer_manager(
        company_name=cust.get("company_name"),
        company_address=cust.get("company_address"),
        gst_number=cust.get("gst_number"),
        contractor_person="",
        contractor_number="",
        contractor_email="",
    )
    new_customer.add(collection_name=CUSTOMER_COLLECTION)
    customer_manager().update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                    update_values={"created_by": raised_by})
    customer_snapshot = {
        "customer_id": new_customer.customer_id,
        "company_name": new_customer.company_name,
        "company_address": new_customer.company_address,
        "gst_number": new_customer.gst_number,
        "contractor_person": "", "contractor_number": "", "contractor_email": "",
        "created_by": raised_by,
    }

    price = details.get("price", 0)
    tax_rate = details.get("tax_rate", 0)
    order_items = [{
        "product_id": i.get("product_id"), "product_name": i.get("product_name"),
        "model_no": i.get("model_no", ""), "serial_numbers": i.get("serial_numbers", []),
        "quantity": i.get("quantity", 1), "price": price, "tax_rate": tax_rate
    } for i in alloc.get("items", [])]

    order = order_manager(
        customer=customer_snapshot, items=order_items,
        payment_mode="Demo Conversion", payment_details={}, discount=0,
        creator={"type": "request", "raised_by": raised_by, "approved_by": approver}
    )
    order.add(collection_name=ORDERS_COLLECTION)

    dispatch = dict(alloc.get("dispatch") or {})
    dispatch.update({
        "invoice_no": invoice_no, "invoice_date": invoice_date,
        "bill_to_address": {"company_name": customer_snapshot["company_name"], "address": customer_snapshot["company_address"]},
    })
    order.update(collection_name=ORDERS_COLLECTION, query={"order_id": order.order_id},
                 update_values={"status": "processing", "dispatch": dispatch,
                                "converted_from_demo": {"allocation_id": alloc.get("allocation_id"),
                                                        "allotment_date": alloc.get("allotment_date")}})
    allocation_manager().delete(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": alloc.get("allocation_id")})
    logging.info(f"demo allocation {alloc.get('allocation_id')} converted to order {order.order_id}")
    return order.order_id


@app.post("/request/order")
def raise_order_request(request: OrderRequestModel, user: dict = Depends(require_role("distributor"))):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product")
        if not request.customer_id and not request.customer.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        if request.payment_mode not in VALID_PAYMENT_MODES:
            raise HTTPException(status_code=400, detail="invalid payment mode")

        req = request_manager(
            request_type="order",
            raised_by=user["username"],
            details={
                "customer_id": request.customer_id,
                "customer": request.customer,
                "items": [item.dict() for item in request.items],
                "payment_mode": request.payment_mode,
                "payment_details": request.payment_details,
                "discount": request.discount
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "request sent, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising order request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.post("/request/service")
def raise_service_request(request: ServiceRequestModel, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        req = request_manager(
            request_type="service",
            raised_by=user["username"],
            details={
                "product_id": request.product_id,
                "serial_no": request.serial_no,
                "purchase_date": request.purchase_date,
                "issue": request.issue,
                "image": request.image,
                "video": request.video,
                "location": request.location,
                "spare_parts": request.spare_parts
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "service request sent, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising service request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.get("/request/")
def all_requests(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = request_manager()
        # return-proof files are base64 blobs — fetched on demand via /request/{id}/proof
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={}, projection={"details.proof.data": 0})
        return {"message": "requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.get("/request/{request_id}/proof")
def request_proof(request_id: str, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        docs = request_manager().get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id},
                                          projection={"details.proof": 1})
        proof = ((docs[0].get("details") or {}).get("proof")) if docs else None
        return {"proof": proof or {}}
    except Exception:
        logging.error("fetching request proof failed")
        raise HTTPException(status_code=500, detail="proof cannot be fetched")


@app.get("/request/mine")
def my_requests(user: dict = Depends(get_current_user)):
    try:
        db = request_manager()
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={"raised_by": user["username"]},
                              projection={"details.proof.data": 0})
        return {"message": "my requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.post("/request/approve/{request_id}")
def approve_request(request_id: str, body: RequestApproveModel = None, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = request_manager()
        existing = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not existing:
            raise HTTPException(status_code=404, detail="request not found")
        req = existing[0]
        if req["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"request already {req['status']}")

        if req["request_type"] == "demo_unit":
            details = req["details"]
            if details.get("customer") or details.get("customer_id"):   # legacy requests raised with customer details
                allocation_id = _fulfill_demo_unit(
                    customer_id=details.get("customer_id", ""),
                    customer=details.get("customer", {}),
                    items=details.get("items", []),
                    allocated_by=req["raised_by"]
                )
                ids = [allocation_id]
            else:
                ids = _fulfill_demo_request(
                    items=details.get("items", []), requester=req["raised_by"],
                    remarks=details.get("remarks", ""), request_id=request_id)
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and demo unit allotted", "allocation_ids": ids}

        if req["request_type"] == "return_demo":
            details = req["details"]
            aid = details.get("allocation_id")
            # same logic as a manual return: marks returned + puts the unit back into stock
            return_allocation(aid, user)
            allocation_manager().update_data(
                collection_name=ALLOCATION_COLLECTION, query={"allocation_id": aid},
                update_values={"return_request": {"request_id": request_id, "status": "approved",
                                                  "returned_through": details.get("returned_through", ""),
                                                  "has_proof": bool(details.get("proof"))}})
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "return approved and demo unit marked as returned"}

        if req["request_type"] == "convert_to_order":
            if not body or not body.invoice_no.strip() or not body.invoice_date.strip():
                raise HTTPException(status_code=400, detail="invoice number and invoice date are required")
            details = req["details"]
            found = allocation_manager().get_data(collection_name=ALLOCATION_COLLECTION,
                                                  query={"allocation_id": details.get("allocation_id")})
            if not found:
                raise HTTPException(status_code=404, detail="demo unit allocation no longer exists")
            order_id = _convert_demo_to_order(found[0], details, req["raised_by"], user["username"],
                                              body.invoice_no.strip(), body.invoice_date.strip())
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and demo unit converted to order", "order_id": order_id}

        if req["request_type"] == "order":
            details = req["details"]
            order_id = _fulfill_order(
                customer_id=details.get("customer_id", ""),
                customer=details.get("customer", {}),
                items=details.get("items", []),
                payment_mode=details.get("payment_mode"),
                payment_details=details.get("payment_details", {}),
                discount=details.get("discount", 0),
                creator={"type": "request", "raised_by": req["raised_by"], "approved_by": user["username"]}
            )
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and order created", "order_id": order_id}

        # service: technician/distributor asked for a new service ticket to be
        # opened — approving creates the real service record and assigns it
        # back to whoever raised the request.
        if req["request_type"] == "service":
            details = req["details"]
            service = service_detail(product_id=details.get("product_id"), serial_no=details.get("serial_no"))
            service.add_service(
                collection_name=SERVICE_COLLECTION,
                purchase_date=details.get("purchase_date"),
                issue=details.get("issue"),
                image=details.get("image", ""),
                video=details.get("video", ""),
                technician_id=req["raised_by"],
                location=details.get("location", "indoor"),
                spare_parts=details.get("spare_parts", "")
            )
            if details.get("video"):
                _raise_media_review_request(service.service_id, user["username"])
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and service created", "service_id": service.service_id}

        # media_review: approving means admin/accounts confirmed they downloaded the
        # video — it's cleared from the database afterwards to free up storage.
        if req["request_type"] == "media_review":
            service_id = req["details"].get("service_id")
            if service_id:
                svc_db = service_detail()
                svc_db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                                    update_values={"video": ""})
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "video download confirmed and removed from the database"}

        # status_update: technician-raised status change, applied only on admin/accounts approval
        if req["request_type"] == "status_update":
            details = req["details"]
            svc_db = service_detail(product_id="", serial_no="")
            svc_db.update_service_status(
                service_status=details.get("service_status"),
                reason=details.get("reason", ""),
                collection_name=SERVICE_COLLECTION,
                query={"service_id": details.get("service_id")},
                image=None,
                video=None,
                spare_parts_used=details.get("spare_parts_used", False),
                spare_parts=details.get("spare_parts", ""),
                service_charges=details.get("service_charges")
            )
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and service status updated", "service_id": details.get("service_id")}

        # spare_part requests: approving now also issues the part — creates a
        # spare-part allocation automatically so it shows up on the Dispatch page
        if req["request_type"] == "spare_part":
            details = req["details"]
            alloc = allocation_manager(
                sales_person={},
                items=[],
                spare_part={
                    "service_id": details.get("service_id"),
                    "part_name": details.get("note", "Spare part"),
                    "quantity": 1
                },
                company_name="",
                address=""
            )
            alloc.add(collection_name=ALLOCATION_COLLECTION)

            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and spare part issued", "allocation_id": alloc.allocation_id}

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="approved", resolved_by=user["username"])
        return {"message": "request approved"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"approving request failed! {e}")
        raise HTTPException(status_code=500, detail=f"request could not be approved: {e}")


@app.post("/request/reject/{request_id}")
def reject_request(request_id: str, request: RequestRejectModel, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = request_manager()
        existing = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not existing:
            raise HTTPException(status_code=404, detail="request not found")
        if existing[0]["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"request already {existing[0]['status']}")

        if existing[0]["request_type"] == "media_review":
            service_id = existing[0]["details"].get("service_id")
            if service_id:
                svc_db = service_detail()
                svc_db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                                    update_values={"video": ""})

        if existing[0]["request_type"] in ("convert_to_order", "return_demo"):
            aid = existing[0]["details"].get("allocation_id")
            field = "convert_request" if existing[0]["request_type"] == "convert_to_order" else "return_request"
            if aid:
                allocation_manager().update_data(
                    collection_name=ALLOCATION_COLLECTION, query={"allocation_id": aid},
                    update_values={field: {"request_id": request_id, "status": "rejected", "reason": request.reason}})

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="rejected", resolved_by=user["username"], reason=request.reason)
        return {"message": "request rejected"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("rejecting request failed!")
        raise HTTPException(status_code=500, detail="request could not be rejected")


@app.post("/allocation/create")
def create_allocation(request: CreateAllocationRequest, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        if not request.items and not request.spare_part:
            raise HTTPException(status_code=400, detail="add at least one product or a spare part")

        sales_person_snapshot = {}
        if request.items:
            if not request.allocated_to:
                raise HTTPException(status_code=400, detail="select a system user to allocate to")
            sales_person_snapshot = _user_snapshot(request.allocated_to)

        inventory_db = inventory_manager()
        # keyed by (product_id, model_no): two variants sharing the same
        # product_id (e.g. black vs grey) must be checked/allocated against
        # their own lot, not each other's stock — same fix as order fulfillment
        for item in request.items:
            available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item.product_id, model_no=item.model_no or None)
            if available < item.quantity:
                variant_note = f" (model {item.model_no})" if item.model_no else ""
                raise HTTPException(status_code=400, detail=f"insufficient stock for {item.product_name}{variant_note}: only {available} available")

        # No more partial returns: every allocated unit becomes its own
        # allocation document (quantity=1, one serial number each) instead of
        # bundling the whole quantity into a single row. A cart of ProductA x2
        # therefore creates two separate rows on the Allocated page, each
        # independently returnable.
        #
        # allocate_serials() (strict) requires every unit to already have a
        # serial number on file — but accessories/spare_parts are legitimately
        # allowed to be stocked with NO serial numbers at all (see
        # /inventory/create), even though get_available_quantity() above
        # correctly counts their quantity as available. That mismatch meant
        # allocating any such product here failed with "insufficient stock"
        # right after the precheck said stock WAS available — allocation
        # would never go through. allocate_units() is the tolerant version
        # used everywhere else in this file (order fulfillment, order edits):
        # it decrements quantity regardless of serial coverage and returns
        # whatever serials it did find, which may be fewer than requested
        # (or none). We still create one allocation row per unit as before —
        # rows for units with no serial on file just carry an empty
        # serial_numbers list instead of failing the whole allocation.
        created_allocation_ids = []
        for item in request.items:
            if item.serial_numbers:
                allocated_serials = inventory_db.allocate_specific_serials(
                    collection_name=INVENTORY_COLLECTION,
                    product_id=item.product_id,
                    serial_numbers=item.serial_numbers,
                    model_no=item.model_no or None
                )
            else:
                allocated_serials = inventory_db.allocate_units(
                    collection_name=INVENTORY_COLLECTION,
                    product_id=item.product_id,
                    quantity=item.quantity,
                    model_no=item.model_no or None
                )
            for i in range(item.quantity):
                serial = allocated_serials[i] if i < len(allocated_serials) else None
                unit_allocation = allocation_manager(
                    sales_person=sales_person_snapshot,
                    items=[{
                        "product_id": item.product_id,
                        "product_name": item.product_name,
                        "model_no": item.model_no,
                        "quantity": 1,
                        "serial_numbers": [serial] if serial else []
                    }],
                    company_name=request.company_name,
                    address=request.address,
                    gst_number=request.gst_number,
                    phone_number=request.phone_number
                )
                unit_allocation.add(collection_name=ALLOCATION_COLLECTION)
                created_allocation_ids.append(unit_allocation.allocation_id)

        spare_part_dict = None
        redirect_to = None
        if request.spare_part:
            svc_db = service_detail()
            existing_service = svc_db.get_service_data(SERVICE_COLLECTION, query={"service_id": request.spare_part.service_id})
            if not existing_service:
                raise HTTPException(status_code=404, detail="selected service not found")

            svc_db.update_data(
                collection_name=SERVICE_COLLECTION,
                query={"service_id": request.spare_part.service_id},
                update_values={"spare_parts_requested": request.spare_part.part_name}
            )
            spare_part_dict = request.spare_part.dict()
            redirect_to = "service.html"

            spare_allocation = allocation_manager(
                spare_part=spare_part_dict,
                company_name=request.company_name,
                address=request.address,
                gst_number=request.gst_number,
                phone_number=request.phone_number
            )
            spare_allocation.add(collection_name=ALLOCATION_COLLECTION)
            created_allocation_ids.append(spare_allocation.allocation_id)

        logging.info(f"allocation(s) created successfully: {created_allocation_ids}")
        return {"message": "allocation created successfully", "allocation_ids": created_allocation_ids, "redirect": redirect_to}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("allocation creation failed!")
        raise HTTPException(status_code=500, detail="allocation creation failed")


@app.post("/allocation/return/{allocation_id}")
def return_allocation(allocation_id: str, user: dict = Depends(require_role("admin", "accounts", "distributor", "service_manager"))):

    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        allocation = matches[0]

        if allocation.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this allocation is already returned")

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={
                "return_status": "returned",
                "return_completed_at": datetime.now(timezone.utc).isoformat(),
                "returned_by": user["username"]
            }
        )
        logging.info(f"allocation {allocation_id} marked as returned")

        damage_report = allocation.get("damage_report") or {}
        if damage_report.get("reported"):
            try:
                inv_db = inventory_manager()
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                reason = f"returned damaged from allocation {allocation_id}"
                if damage_report.get("issue"):
                    reason += f" — {damage_report['issue']}"

                if allocation.get("allocation_type") == "spare_part":
                    sp = allocation.get("spare_part", {})
                    part_name = sp.get("part_name", "")
                    qty = sp.get("quantity", 0) or 0
                    if part_name and qty > 0:
                        inventory_manager(
                            product_name=part_name,
                            product_id=f"DMG-{uuid.uuid4().hex[:8].upper()}",
                            quantity=qty,
                            purchase_date=today,
                            product_type="damaged",
                            reason=reason,
                        ).add(collection_name=INVENTORY_COLLECTION)
                else:
                    for item in allocation.get("items", []):
                        product_name = item.get("product_name", "")
                        qty = item.get("quantity", 0) or 0
                        if not product_name or qty <= 0:
                            continue
                        original_product_id = item.get("product_id") or ""

                        product_id = f"DMG-{uuid.uuid4().hex[:8].upper()}"
                        item_reason = reason + (f" (original product_id: {original_product_id})" if original_product_id else "")
                        inventory_manager(
                            product_name=product_name,
                            product_id=product_id,
                            quantity=qty,
                            purchase_date=today,
                            serial_numbers=item.get("serial_numbers", []) or [],
                            product_type="damaged",
                            reason=item_reason,
                        ).add(collection_name=INVENTORY_COLLECTION)

                logging.info(f"allocation {allocation_id}'s damaged item(s) filed into inventory as damaged product")
            except Exception as inv_err:
                logging.error(f"allocation {allocation_id} returned but filing damaged item(s) into inventory failed: {inv_err}")
        elif allocation.get("allocation_type") != "spare_part":
            # normal (undamaged) return of an allocated product: the units go
            # back into live stock instead of the damaged bucket. Spare parts
            # aren't restocked here — they were consumed by the service, not
            # returned as a unit.
            try:
                inv_db = inventory_manager()
                for item in allocation.get("items", []):
                    product_name = item.get("product_name", "")
                    qty = item.get("quantity", 0) or 0
                    if not product_name or qty <= 0:
                        continue
                    inv_db.restock_returned_units(
                        collection_name=INVENTORY_COLLECTION,
                        product_id=item.get("product_id", ""),
                        product_name=product_name,
                        model_no=item.get("model_no", ""),
                        quantity=qty,
                        serial_numbers=item.get("serial_numbers", []) or [],
                    )
                logging.info(f"allocation {allocation_id}'s item(s) restocked into inventory on return")
            except Exception as inv_err:
                logging.error(f"allocation {allocation_id} returned but restocking inventory failed: {inv_err}")

        return {"message": "allocation marked as returned", "allocation_id": allocation_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"marking allocation as returned failed! {e}")
        raise HTTPException(status_code=500, detail="allocation cannot be marked as returned")


app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")
app.mount("/images", StaticFiles(directory=os.path.join(BASE_DIR, "images")), name="images")
app.mount("/pages", StaticFiles(directory=os.path.join(BASE_DIR, "pages"), html=True), name="pages")

app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="root")