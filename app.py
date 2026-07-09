from login.customer_details import login
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from logger import logging
from configuration import load_params

app = FastAPI()
params = load_params()

COLLECTION_NAME = params["account_creation_collection_name"]


class LoginRequest(BaseModel):
    username: str
    password: str
    role: str


class CreateAccountRequest(BaseModel):
    username: str
    password: str
    confirm_password: str
    email_id: str
    gst_number: str
    company_name: str
    mobile_no: str
    role: str


@app.post("/login/")
async def login_page(request: LoginRequest):
    try:
        # username field missing tha login class mein -- neeche note dekho
        dataset = login.get_data(
            None, COLLECTION_NAME, query={"full_name": request.username}
        )

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

        existing_user = login.get_data(
            None, COLLECTION_NAME, query={"full_name": request.username}
        )
        if existing_user:
            raise HTTPException(status_code=409, detail="username was already registered please try a different username")

        new_user = login(
            name=request.username,
            phone=request.mobile_no,
            email=request.email_id,
            company_name=request.company_name,
            gst_number=request.gst_number,
            role=request.role,
            password=request.password
        )
        new_user.add(collection_name=COLLECTION_NAME)

        logging.info("account creation was successful")
        return {"message": "account creation was successful"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("account creation was failed!")
        raise HTTPException(status_code=500, detail="account creation failed")