from python import logging
from python.mongodb_connection import mongodbclient
import uuid
import enum


class login_role(str, enum.Enum):
    admin = "admin"
    employee = "employee"
    technician = "technician"
    distributor = "distributor"


class login(mongodbclient):

    # NOTE: all fields now default to None. Several routes in main.py do
    # `db = login()` just to reuse get_data/delete/update (inherited from
    # mongodbclient) without wanting to construct a full user object.
    # Previously every field was a required positional arg, so those calls
    # raised TypeError before ever reaching the try/except in the route.
    def __init__(self, username: str = None, name: str = None, phone: str = None,
                 email: str = None, company_name: str = None, gst_number: str = None,
                 role: str = None, password: str = None):

        super().__init__()

        # Only validate role if one was actually supplied (i.e. we're really
        # creating/registering a user, not just borrowing db methods).
        if role is not None and role not in [r.value for r in login_role]:
            raise Exception(f"invalid role {role}")

        self.username = username
        self.full_name = name
        self.mobile_no = phone
        self.email_id = email
        self.company_name = company_name
        self.gst_number = gst_number
        self.role = role
        self.password = password

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("data fetching was failed!")
            raise Exception(e)

    def add(self, collection_name):
        try:
            user_docs = {
                "username": self.username,
                "full_name": self.full_name,
                "mobile_no": self.mobile_no,
                "email_id": self.email_id,
                "company_name": self.company_name,
                "gst_number": self.gst_number,
                "user_id": str(uuid.uuid4()),
                "role": self.role,
                "password": self.password
            }
            result = super().add(collection_name=collection_name, dictionary=user_docs)
            return result
        except Exception as e:
            logging.error("adding details failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            deleted_user = super().delete_data(collection_name=collection_name, query=query, many=many)
            return deleted_user
        except Exception as e:
            logging.error("deletion was not successful")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            updated_data = super().update_data(collection_name=collection_name, query=query,
                                                 update_values=update_values, many=many)
            return updated_data
        except Exception as e:
            logging.error("data updation was failed!")
            raise Exception(e)
