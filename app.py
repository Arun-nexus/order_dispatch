from login.customer_details import login
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from logger import logging
from configuration import load_params
from order.mamage_order import order_manager
from mongo.mongodb_connection import mongodbclient

app = FastAPI()
params = load_params()


ACCOUNTS_COLLECTION = params["account_creation_collection_name"]
ORDERS_COLLECTION = params["order_collection_name"]

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

class CreateOrderRequest(BaseModel):
    product_name : str
    product_id :str
    company_name : str
    gst_number :str
    payment_mode : str
    
class OrderStatusRequest(BaseModel):
    order_id : str

@app.post("/login/")
async def login_page(request: LoginRequest):
    
    try:
        db = mongodbclient()
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


@app.post("/create_account/")
async def create_account(request: CreateAccountRequest):
    
    try:
        if request.password != request.confirm_password:
            raise HTTPException(status_code=400, detail="confirm password is not same as password")

        if len(request.mobile_no) != 10 or not request.mobile_no.isdigit():
            raise HTTPException(status_code=400, detail="make sure mobile no is valid")

        db = mongodbclient()
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
    
@app.post("/create_order/")
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
        db = mongodbclient()
        dataset = db.get_data(ORDERS_COLLECTION,query={"order_id": order_id})

        if not dataset:
            raise HTTPException(status_code=404,detail= "no order found with this order_id")
        return dataset[0]
    
    except Exception as e:
        logging.error("order tracking failed!")
        raise HTTPException(status_code= 500 , detail="order tracking failed!")
    
@app.post("/confirm delivery/")
async def confirm_delivery(request : OrderStatusRequest):
    
    try:
        db = mongodbclient()
        result = db.update_data(ORDERS_COLLECTION,query={"order_id":request.order_id},update_values = {"status": "delivered"})

        if result.matched_count == 0:
            raise HTTPException(status_code=404,detail="no order found with this id")
        
        return {"messages": "delivery confirmed" , "order_id" : request.order_id}
    
    except HTTPException:
        raise
    
    except Exception as e:
        logging.error("delivery confimation failed")
        raise HTTPException(status_code=500,detail="delivery confirmation failed")
    