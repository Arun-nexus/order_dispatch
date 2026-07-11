from login.customer_details import login
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from logger import logging
from configuration import load_params
from order.mamage_order import order_manager
from service.service_details import service_detail
from inventory.inventory_handling import inventory_manager

app = FastAPI()
params = load_params()


ACCOUNTS_COLLECTION = params["account_creation_collection_name"]
ORDERS_COLLECTION = params["order_collection_name"]
SERVICE_COLLECTION = params["service_collection_name"]
INVENTORY_COLLECTION = params["inventory_collection_name"]

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
    updated_values: str

class ServiceRequest(BaseModel):
    product_id: str
    serial_no : str
    technician_id : str
    purchase_date : str
    issue : str
    image : str
    video : str
    spare_parts :str

class CreateOrderRequest(BaseModel):
    product_name : str
    product_id :str
    company_name : str
    gst_number :str
    payment_mode : str
    
class OrderStatusRequest(BaseModel):
    order_id : str

class ServiceStatusRequest(BaseModel):
    service_id : str

class ServiceUpdateRequest(BaseModel):
    updated_values : str

class OrderUpdatedValue(BaseModel):
    updated_order_value : str

class InventoryRequest(BaseModel):
    product_name : str
    product_id : str
    quantity : int
    purchase_date : str
    lot_no : str
    supplier : str
    price : str
    tax_rate : int

class InventoryUpdateRequest(BaseModel):
    product_id : str
    updated_values :str

@app.post("/login/")
async def login_page(request: LoginRequest):
    
    try:
        db = login()
        dataset = db.get_data(ACCOUNTS_COLLECTION,query={"username":request.username})


        if not dataset:
            raise HTTPException(
                status_code=404,
                detail="username was not registered! please create account before login."
            )

        user = dataset[0]

        if user["password"] != request.password or user["role"] != request.role:
            raise HTTPException(status_code=401, detail="details did not match")

        return {"message": "access granted", "role": user["role"]}

    except HTTPException:
        raise
    
    except Exception as e:
        logging.error("login was not successful")
        raise HTTPException(status_code=500, detail="login failed")

@app.get("/account/")
async def account():
    try:
        db = login()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION,query= {"query" : "*"})
        logging.info("account dataset was fetched successfully")

        return {"message": "account dataset" , "dataset" : dataset}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("account dataset cannot be fetched")
        raise HTTPException(status_code=500,detail = "account informations cannot be fetched")

#fastapi middleware only accessible for admin
@app.post("/account/create_account/")
async def create_account(request: CreateAccountRequest):
    
    try:
        if request.password != request.confirm_password:
            raise HTTPException(status_code=400, detail="confirm password is not same as password")

        if len(request.mobile_no) != 10 or not request.mobile_no.isdigit():
            raise HTTPException(status_code=400, detail="make sure mobile no is valid")

        db = order_manager()
        existing_user = db.get_data(ACCOUNTS_COLLECTION,query= {"username":request.username})

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
async def delete_account(request:CreateAccountRequest):
    try:
        db = login()
        delete_account = db.delete(collection_name=ACCOUNTS_COLLECTION,query={"username" : request.username})
        logging.info("account deleted successfully")
        return {"message" :"account was deleted successfully", "username" : request.username}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("account cannot be deleted. ")
        raise HTTPException(status_code=500,detail="account cannot be deleted")
    
@app.post("/login/update_account/{username}")
async def update_account(request:CreateAccountRequest,updated_values:UpdateAccountRequest):
    try:
        db = login()
        update_account = db.update(collection_name=ACCOUNTS_COLLECTION,query={"username":request.username},update_values=updated_values.updated_values)
        logging.info("account values are updated")
        return{"message":"account details was updated","username": request.username , "updated_value" : updated_values.updated_values}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("account details updation was failed")
        raise HTTPException(status_code=500,detail="account details updation was unsuccessful")
    
@app.post("/order/create_order/")
async def create_order(request:CreateOrderRequest):
    
    try:
        order = order_manager(product_name=request.product_name,product_id=request.product_id,company_name=request.company_name,gst_number=request.gst_number,payment_mode=request.payment_mode)
        order.add(collection_name=ORDERS_COLLECTION)

        logging.info(f"order with {order.order_id} created successfully")
        return {"message": "order created successfully" , "order_id" : order.order_id}
    
    except Exception as e:
        logging.error("order creation failed!")
        raise HTTPException(status_code=500,detail="order creation failed")

@app.get("/track_order/{order_id}")
async def track_order(order_id : str):
    
    try:
        db = order_manager()
        dataset = db.order_tracking(ORDERS_COLLECTION,query={"order_id": order_id})

        if not dataset:
            raise HTTPException(status_code=404,detail= "no order found with this order_id")
        return dataset[0]
    
    except Exception as e:
        logging.error("order tracking failed!")
        raise HTTPException(status_code= 500 , detail="order tracking failed!")
    
@app.post("/confirm delivery/{order_id}")
async def confirm_delivery(request : OrderStatusRequest):
    
    try:
        db = order_manager()
        result = db.delivery_confirmation(ORDERS_COLLECTION,query={"order_id":request.order_id},update_values = {"status": "delivered"})

        if result.matched_count == 0:
            raise HTTPException(status_code=404,detail="no order found with this id")
        
        return {"messages": "delivery confirmed" , "order_id" : request.order_id}
    
    except HTTPException:
        raise
    
    except Exception as e:
        logging.error("delivery confimation failed")
        raise HTTPException(status_code=500,detail="delivery confirmation failed")

@app.post("/order/delete/{order_id}")
async def delete_order(request:OrderStatusRequest):
    try:
        db = order_manager()
        db.delete_data(collection_name = ORDERS_COLLECTION,query={"order_id":request.order_id})
        return {"message":"order_deleted","order_id":request.order_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order deletion failed") 
        raise HTTPException(status_code=500,detail="order deletion failed!")

@app.post("/order/update/{order_id}")
async def update_order(request:OrderStatusRequest,updated_value = OrderUpdatedValue):
    try:
        db = order_manager()
        db.update_data(collection_name=ORDERS_COLLECTION,query={"order_id" : request.order_id},update_values=updated_value.updated_order_value)
        logging.info("order value was updated successfully.")
        return {"message" : "order value was updated" , "order_id" : request.order_id , "updated_value" : updated_value.updated_order_value}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order cannot be updated")
        raise HTTPException(status_code=500,detail="order value cannot be updated")

@app.get("/order/")
async def order():
    try:
        db = order_manager()
        dataset = db.get_data(collection_name=ORDERS_COLLECTION,query= {"query" : "*"})
        logging.info("order dataset was fetched successfully")

        return {"message": "order dataset" , "dataset" : dataset}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order dataset cannot be fetched")

@app.get("/service/")
async def services(request):
    try:
        db = service_detail()
        dataset = db.get_data(collection_name=INVENTORY_COLLECTION,query= {"query" : "*"})
        logging.info("inventory dataset was fetched successfully")

        return {"message": "inventory dataset" , "dataset" : dataset}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory dataset cannot be fetched")

@app.post("/services/create")
async def create_sevice(request:ServiceRequest):
    
    try:
        service = service_detail(product_id = request.product_id,serail_no = request.serial_no)
        service_detail.add_service(collection_name=SERVICE_COLLECTION,purchase_date=request.purchase_date,issue=request.issue,image=request.image,video=request.video,technician_id=request.technician_id,)
        logging.info(f"service creation was successfull with service_id{service.service_id}!")
        return {"message":"service creation was successful!","service_id":{service.service_id}}
    
    except HTTPException:
        raise

    except Exception as e:
        logging.error("service creation failed!")
        raise HTTPException(status_code=500,detail= "service cannot be created!")
    
@app.post("/service/delete/{service_id}")
async def delete_service(request:ServiceStatusRequest):
    try:
        db = service_detail()
        deleted_file = db.delete_service(collection_name=SERVICE_COLLECTION,query=request.service_id)
        logging.info(f"service was deleted successfully service id {request.service_id}")
        return {"message" : "service deletion was successful","service_id": request.service_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("service deletion was failed!")
        raise HTTPException(status_code=500,detail="service cannot be deleted")

@app.post("/service/update/{service_id}")
async def update_service(request:ServiceStatusRequest,updated_value: ServiceUpdateRequest):
    try:
        db = service_detail()
        updated_file = db.update_service_status(collection_name=SERVICE_COLLECTION,query=request.service_id,update_values=updated_value.updated_values)
        logging.info("service was updated")     
        return {"message" : " service was updated successfully","service_id": request.service_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("service updation was unsuccessful!")
        raise HTTPException(status_code=500,detail="service cannot be updated")
    
@app.get("/inventory/")
async def inventory(request):
    try:
        db = inventory_manager()
        dataset = db.get_data(collection_name=INVENTORY_COLLECTION,query= {"query" : "*"})
        logging.info("inventory dataset was fetched successfully")

        return {"message": "inventory dataset" , "dataset" : dataset}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory dataset cannot be fetched")

@app.post("/inventory/create")
async def create_inventory(request:InventoryRequest):
    
    try:
        inventory = inventory_manager(product_name = request.product_name,product_id = request.product_id,quantity=request.quantity,purchase_date=request.purchase_date,lot_no=request.lot_no,supplier=request.supplier,price=request.price,tax_rate=request.tax_rate)
        inventory.add(collection_name=SERVICE_COLLECTION)
        logging.info(f"product listed successfully on inventory")
        return {"message":"product was listed successfully"}
    
    except HTTPException:
        raise

    except Exception as e:
        logging.error("product cannot be listed to the inventory")
        raise HTTPException(status_code=500,detail= "product can't list into the inventory")
    
@app.post("/inventory/update/{product_id}")
async def update_inventory(request:InventoryUpdateRequest):
    try:
        db = inventory_manager()
        updated_file = db.update(collection_name=INVENTORY_COLLECTION,query=request.product_id,update_values=request.updated_values)
        logging.info("inventory was updated")     
        return {"message" : " inventory was updated successfully","product_id": request.product_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory updation was unsuccessful!")
        raise HTTPException(status_code=500,detail="inventory cannot be updated")
    
@app.post("/inventory/delete/{product_id}")
async def delete_product(request:InventoryUpdateRequest):
    try:
        db = inventory_manager(product_id=request.product_id)
        deleted_file = db.delete(collection_name=SERVICE_COLLECTION)
        logging.info(f"product was deleted successfully from the inventory {request.product_id}")
        return {"message" : "product deletion was successful","product_id": request.product_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("product deletion was failed!")
        raise HTTPException(status_code=500,detail="product cannot be deleted")