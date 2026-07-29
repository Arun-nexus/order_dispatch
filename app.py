from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from logger import logging
from configuration import load_params
from dotenv import load_dotenv
from mongodb.mongodb_connection import mongodbclient
from user.company import login
from order.manage_order import order_manager
from service.service_details import service_detail
from inventory.inventory_handling import inventory_manager
from user.customer_details import customer_manager
from sales.sales_person_manager import sales_person_manager
from allocation.allocation import allocation_manager
from auth import create_access_token, get_current_user, require_role
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import os

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
    quantity: int
    price: float
    tax_rate: float = 0


class CreateOrderRequest(BaseModel):
    customer_id: str = ""          # set when an existing customer was picked
    customer: dict = {}            # denormalized snapshot: company_name, company_address,
                                    # gst_number, contractor_person, contractor_number, contractor_email
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}     # credit_days / cheque_number+cheque_date / dd_number+dd_date etc.
    discount: float = 0


class CustomerRequest(BaseModel):
    company_name: str
    company_address: str = ""
    gst_number: str = ""
    contractor_person: str = ""
    contractor_number: str = ""
    contractor_email: str = ""


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


class SparePartAllocation(BaseModel):
    service_id: str
    part_name: str
    quantity: int = 1


class CreateAllocationRequest(BaseModel):
    sales_person_id: str = ""
    sales_person: dict = {}
    items: list[AllocationItem] = []
    spare_part: SparePartAllocation | None = None
    company_name: str = ""
    address: str = ""


class OrderStatusRequest(BaseModel):
    order_id: str


class ServiceUpdateRequest(BaseModel):
    service_status: str
    reason: str = ""
    image: str = None
    video: str = None
    spare_parts_used: bool = False
    spare_parts: str = ""


class ServiceChargeRequest(BaseModel):
    service_charges: float


class ServiceMediaRequest(BaseModel):
    image: str = None
    video: str = None


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


class InventoryUpdateRequest(BaseModel):
    updated_values: dict


@app.get("/")
async def home():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/main_dashboard.html")
async def dashboard():
    return FileResponse(os.path.join(BASE_DIR, "main_dashboard.html"))


@app.post("/login/")
async def login_page(request: LoginRequest):
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
async def account(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        logging.info("account dataset was fetched successfully")
        return {"message": "account dataset", "dataset": dataset}
    except Exception as e:
        logging.error("account dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="account informations cannot be fetched")


@app.get("/account/technicians")
async def list_technicians(user: dict = Depends(get_current_user)):
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


@app.post("/account/create_account/")
async def create_account(request: CreateAccountRequest, user: dict = Depends(require_role("admin"))):
    try:
        if request.password != request.confirm_password:
            raise HTTPException(status_code=400, detail="confirm password is not same as password")

        if len(request.mobile_no) != 10 or not request.mobile_no.isdigit():
            raise HTTPException(status_code=400, detail="make sure mobile no is valid")

        db = login()
        existing_user = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if existing_user:
            raise HTTPException(status_code=409, detail="username was already registered please try a different username")

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

        logging.info("account creation was successful")
        return {"message": "account creation was successful"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("account creation was failed!")
        raise HTTPException(status_code=500, detail="account creation failed")


@app.post("/login/delete_account/{username}")
async def delete_account(username: str, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.delete(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
        logging.info("account deleted successfully")
        return {"message": "account was deleted successfully", "username": username}

    except Exception as e:
        logging.error("account cannot be deleted.")
        raise HTTPException(status_code=500, detail="account cannot be deleted")


@app.post("/login/update_account/{username}")
async def update_account(username: str, updated_values: UpdateAccountRequest, user: dict = Depends(require_role("admin"))):
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


@app.post("/order/create_order/")
async def create_order(request: CreateOrderRequest, user: dict = Depends(get_current_user)):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product to the order")

        if request.payment_mode not in VALID_PAYMENT_MODES:
            raise HTTPException(status_code=400, detail="invalid payment mode")

        if request.payment_mode == "Credit":
            credit_days = request.payment_details.get("credit_days")
            if not credit_days or not (0 < int(credit_days) <= 60):
                raise HTTPException(status_code=400, detail="credit days must be between 1 and 60")

        if request.payment_mode == "Cheque" and not request.payment_details.get("cheque_number"):
            raise HTTPException(status_code=400, detail="cheque number is required")

        if request.payment_mode == "DemandDraft" and not request.payment_details.get("dd_number"):
            raise HTTPException(status_code=400, detail="demand draft number is required")

        if request.payment_mode == "UPI" and not request.payment_details.get("upi_id"):
            raise HTTPException(status_code=400, detail="UPI ID is required")

        if request.payment_mode == "NetBanking" and not (
            request.payment_details.get("bank_name")
            and request.payment_details.get("account_number")
            and request.payment_details.get("ifsc_code")
        ):
            raise HTTPException(status_code=400, detail="bank name, account number and IFSC code are required")

        if request.payment_mode == "Cash" and not request.payment_details.get("received_by"):
            raise HTTPException(status_code=400, detail="received-by person name is required")

        customer_db = customer_manager()
        customer_snapshot = dict(request.customer or {})

        if request.customer_id:
            existing = customer_db.get_data(CUSTOMER_COLLECTION, query={"customer_id": request.customer_id})
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
            customer_snapshot = {
                "customer_id": new_customer.customer_id,
                "company_name": new_customer.company_name,
                "company_address": new_customer.company_address,
                "gst_number": new_customer.gst_number,
                "contractor_person": new_customer.contractor_person,
                "contractor_number": new_customer.contractor_number,
                "contractor_email": new_customer.contractor_email,
            }

        inventory_db = inventory_manager()

        # pre-check availability for every line before mutating any inventory
        for item in request.items:
            available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item.product_id)
            if available < item.quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"insufficient stock for {item.product_name}: only {available} available"
                )

        order_items = []
        for item in request.items:
            allocated_serials = inventory_db.allocate_serials(
                collection_name=INVENTORY_COLLECTION,
                product_id=item.product_id,
                quantity=item.quantity
            )
            order_item = item.dict()
            order_item["serial_numbers"] = allocated_serials
            order_items.append(order_item)

        order = order_manager(
            customer=customer_snapshot,
            items=order_items,
            payment_mode=request.payment_mode,
            payment_details=request.payment_details,
            discount=request.discount
        )
        order.add(collection_name=ORDERS_COLLECTION)

        logging.info(f"order {order.order_id} created successfully")
        return {"message": "order created successfully", "order_id": order.order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order creation failed!")
        raise HTTPException(status_code=500, detail="order creation failed")


@app.get("/track_order/{order_id}")
async def track_order(order_id: str, user: dict = Depends(get_current_user)):
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
async def confirm_delivery(order_id: str, user: dict = Depends(require_role("admin", "employee"))):
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
async def delete_order(order_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = order_manager()
        db.delete(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        return {"message": "order deleted", "order_id": order_id}
    except Exception as e:
        logging.error("order deletion failed")
        raise HTTPException(status_code=500, detail="order deletion failed!")


@app.post("/order/update/{order_id}")
async def update_order(order_id: str, updated_value: OrderUpdatedValue, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = order_manager()
        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id},update_values=updated_value.updated_order_value)
        logging.info("order value was updated successfully.")
        return {"message": "order value was updated", "order_id": order_id,
                "updated_value": updated_value.updated_order_value}
    except Exception as e:
        logging.error("order cannot be updated")
        raise HTTPException(status_code=500, detail="order value cannot be updated")


@app.get("/order/")
async def order(user: dict = Depends(get_current_user)):
    try:
        db = order_manager()
        dataset = db.get_data(collection_name=ORDERS_COLLECTION, query={})
        logging.info("order dataset was fetched successfully")
        return {"message": "order dataset", "dataset": dataset}
    except Exception as e:
        logging.error("order dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="order dataset cannot be fetched")


@app.get("/service/")
async def services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={})
        logging.info("service dataset was fetched successfully")
        return {"message": "service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/services/create")
async def create_service(request: ServiceRequest, user: dict = Depends(require_role("admin", "employee"))):
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
        return {"message": "service creation was successful!", "service_id": service.service_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("service creation failed!")
        raise HTTPException(status_code=500, detail="service cannot be created!")


@app.post("/service/delete/{service_id}")
async def delete_service(service_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.delete_service(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        logging.info(f"service was deleted successfully service id {service_id}")
        return {"message": "service deletion was successful", "service_id": service_id}
    except Exception as e:
        logging.error("service deletion was failed!")
        raise HTTPException(status_code=500, detail="service cannot be deleted")


@app.post("/service/update/{service_id}")
async def update_service(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("admin", "employee", "technician"))):
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
            spare_parts=request.spare_parts
        )
        logging.info("service was updated")
        return {"message": "service was updated successfully", "service_id": service_id}
    except Exception as e:
        logging.error("service updation was unsuccessful!")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/service/my")
async def my_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={"technician_alloted": user["username"]})
        logging.info(f"service dataset fetched for technician {user['username']}")
        return {"message": "my service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("technician service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/service/update_charges/{service_id}")
async def update_service_charges(service_id: str, request: ServiceChargeRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail()
        db.set_service_charges(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, service_charges=request.service_charges)
        return {"message": "service charges updated", "service_id": service_id, "service_charges": request.service_charges}
    except Exception as e:
        logging.error("service charges update failed!")
        raise HTTPException(status_code=500, detail="service charges cannot be updated")


@app.post("/service/upload_media/{service_id}")
async def upload_service_media(service_id: str, request: ServiceMediaRequest, user: dict = Depends(require_role("admin", "employee", "technician"))):
    try:
        db = service_detail()
        db.attach_media(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, image=request.image, video=request.video)
        return {"message": "media uploaded successfully", "service_id": service_id}
    except Exception as e:
        logging.error("service media upload failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/service/request_spare_part/{service_id}")
async def request_spare_part(service_id: str, request: SparePartRequest, user: dict = Depends(require_role("admin", "employee", "technician"))):
    try:
        db = service_detail()
        db.request_spare_part(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, note=request.note)
        return {"message": "spare part requested successfully", "service_id": service_id}
    except Exception as e:
        logging.error("spare part request failed!")
        raise HTTPException(status_code=500, detail="spare part request failed")


@app.post("/service/manager_confirm/{service_id}")
async def manager_confirm(service_id: str, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.manager_confirm_return(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        return {"message": "manager confirmed part return", "service_id": service_id}
    except Exception as e:
        logging.error("manager confirmation failed!")
        raise HTTPException(status_code=500, detail="manager confirmation failed")


@app.post("/service/extend_warranty/{service_id}")
async def extend_warranty(service_id: str, request: ExtendWarrantyRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.extend_warranty(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, warranty_until=request.warranty_until)
        return {"message": "warranty extended", "service_id": service_id, "warranty_until": request.warranty_until}
    except Exception as e:
        logging.error("warranty extension failed!")
        raise HTTPException(status_code=500, detail="warranty extension failed")


@app.get("/inventory/")
async def inventory(user: dict = Depends(get_current_user)):
    try:
        db = inventory_manager()
        dataset = db.get_data(collection_name=INVENTORY_COLLECTION, query={})
        logging.info("inventory dataset was fetched successfully")
        return {"message": "inventory dataset", "dataset": dataset}
    except Exception as e:
        logging.error("inventory dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="inventory dataset cannot be fetched")


@app.post("/inventory/create")
async def create_inventory(request: InventoryRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        if len(request.serial_numbers) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match quantity")
        if len(set(request.serial_numbers)) != len(request.serial_numbers):
            raise HTTPException(status_code=400, detail="serial numbers must be unique")

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
            serial_numbers=request.serial_numbers
        )
        inventory_item.add(collection_name=INVENTORY_COLLECTION)
        logging.info("product listed successfully on inventory")
        return {"message": "product was listed successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("product cannot be listed to the inventory")
        raise HTTPException(status_code=500, detail="product can't list into the inventory")


@app.post("/inventory/update/{product_id}")
async def update_inventory(product_id: str, request: InventoryUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = inventory_manager()
        db.update(collection_name=INVENTORY_COLLECTION, query={"product_id": product_id},
                   update_values=request.updated_values)
        logging.info("inventory was updated")
        return {"message": "inventory was updated successfully", "product_id": product_id}
    except Exception as e:
        logging.error("inventory updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="inventory cannot be updated")


@app.post("/inventory/delete/{product_id}")
async def delete_product(product_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = inventory_manager(product_id=product_id)
        db.delete(collection_name=INVENTORY_COLLECTION)
        logging.info(f"product was deleted successfully from the inventory {product_id}")
        return {"message": "product deletion was successful", "product_id": product_id}
    except Exception as e:
        logging.error("product deletion was failed!")
        raise HTTPException(status_code=500, detail="product cannot be deleted")


@app.get("/customer/")
async def customers(user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        dataset = db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
        logging.info("customer dataset was fetched successfully")
        return {"message": "customer dataset", "dataset": dataset}
    except Exception as e:
        logging.error("customer dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="customer dataset cannot be fetched")


@app.get("/customer/search")
async def search_customer(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        dataset = db.search(collection_name=CUSTOMER_COLLECTION, term=term) if term else db.get_data(CUSTOMER_COLLECTION, query={})
        return {"message": "customer search results", "dataset": dataset}
    except Exception as e:
        logging.error("customer search failed")
        raise HTTPException(status_code=500, detail="customer search failed")


@app.post("/customer/create")
async def create_customer(request: CustomerRequest, user: dict = Depends(require_role("admin", "employee"))):
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
            }
        }
    except Exception as e:
        logging.error("customer creation failed!")
        raise HTTPException(status_code=500, detail="customer creation failed")


@app.post("/customer/update/{customer_id}")
async def update_customer(customer_id: str, request: CustomerUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
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
async def delete_customer(customer_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = customer_manager()
        db.delete(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        logging.info(f"customer was deleted successfully {customer_id}")
        return {"message": "customer deletion was successful", "customer_id": customer_id}
    except Exception as e:
        logging.error("customer deletion was failed!")
        raise HTTPException(status_code=500, detail="customer cannot be deleted")


@app.get("/salesperson/search")
async def search_salesperson(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = sales_person_manager()
        dataset = db.search(collection_name=SALESPERSON_COLLECTION, term=term) if term else db.get_data(SALESPERSON_COLLECTION, query={})
        return {"message": "sales person search results", "dataset": dataset}
    except Exception as e:
        logging.error("sales person search failed")
        raise HTTPException(status_code=500, detail="sales person search failed")


@app.post("/salesperson/create")
async def create_salesperson(request: SalesPersonRequest, user: dict = Depends(require_role("admin", "employee"))):
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
async def active_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION,
                                       query={"status": {"$in": ["active", "in_progress"]}})
        return {"message": "active services", "dataset": dataset}
    except Exception as e:
        logging.error("fetching active services failed")
        raise HTTPException(status_code=500, detail="active services cannot be fetched")


@app.get("/allocation/")
async def allocations(user: dict = Depends(get_current_user)):
    try:
        db = allocation_manager()
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION, query={})
        return {"message": "allocation dataset", "dataset": dataset}
    except Exception as e:
        logging.error("fetching allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


@app.post("/allocation/create")
async def create_allocation(request: CreateAllocationRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        if not request.items and not request.spare_part:
            raise HTTPException(status_code=400, detail="add at least one product or a spare part")

        sales_person_snapshot = {}
        if request.items:
            sp_db = sales_person_manager()
            if request.sales_person_id:
                existing = sp_db.get_data(SALESPERSON_COLLECTION, query={"sales_person_id": request.sales_person_id})
                if not existing:
                    raise HTTPException(status_code=404, detail="selected sales person not found")
                sales_person_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
            else:
                if not request.sales_person.get("name"):
                    raise HTTPException(status_code=400, detail="sales person details are required")
                new_sp = sales_person_manager(
                    name=request.sales_person.get("name"),
                    company_name=request.sales_person.get("company_name"),
                    address=request.sales_person.get("address"),
                    contact_number=request.sales_person.get("contact_number"),
                    email=request.sales_person.get("email"),
                )
                new_sp.add(collection_name=SALESPERSON_COLLECTION)
                sales_person_snapshot = {
                    "sales_person_id": new_sp.sales_person_id,
                    "name": new_sp.name,
                    "company_name": new_sp.company_name,
                    "address": new_sp.address,
                    "contact_number": new_sp.contact_number,
                    "email": new_sp.email,
                }

        inventory_db = inventory_manager()
        allocation_items = []
        for item in request.items:
            available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item.product_id)
            if available < item.quantity:
                raise HTTPException(status_code=400, detail=f"insufficient stock for {item.product_name}: only {available} available")

        for item in request.items:
            allocated_serials = inventory_db.allocate_serials(
                collection_name=INVENTORY_COLLECTION,
                product_id=item.product_id,
                quantity=item.quantity
            )
            allocation_items.append({
                "product_id": item.product_id,
                "product_name": item.product_name,
                "quantity": item.quantity,
                "serial_numbers": allocated_serials
            })

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

        allocation = allocation_manager(
            sales_person=sales_person_snapshot,
            items=allocation_items,
            spare_part=spare_part_dict,
            company_name=request.company_name,
            address=request.address
        )
        allocation.add(collection_name=ALLOCATION_COLLECTION)

        logging.info(f"allocation {allocation.allocation_id} created successfully")
        return {"message": "allocation created successfully", "allocation_id": allocation.allocation_id, "redirect": redirect_to}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("allocation creation failed!")
        raise HTTPException(status_code=500, detail="allocation creation failed")


@app.post("/allocation/return/{allocation_id}")
async def return_allocation(allocation_id: str, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = allocation_manager()
        db.mark_returned(collection_name=ALLOCATION_COLLECTION, allocation_id=allocation_id)
        return {"message": "allocation marked as returned", "allocation_id": allocation_id}
    except Exception as e:
        logging.error("marking allocation as returned failed!")
        raise HTTPException(status_code=500, detail="allocation cannot be marked as returned")


app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")
app.mount("/images", StaticFiles(directory=os.path.join(BASE_DIR, "images")), name="images")
app.mount("/pages", StaticFiles(directory=os.path.join(BASE_DIR, "pages"), html=True), name="pages")

app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="root")