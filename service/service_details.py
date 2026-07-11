from mongo.mongodb_connection import mongodbclient
from logger import logging
import uuid


class service_detail(mongodbclient):
    super().__init__()

    def __init__(self, product_id: str, serial_no: str, status="active"):
        
        self.product_id = product_id
        self.serial_no = serial_no
        self.status = status
        self.spare_parts = ""
        self.service_id = uuid.uuid4()

    def add_service(self, technician_id, purchase_date: str, issue: str,image: str, video: str, collection_name: str,spare_parts: str = "", status="active"):
        try:
            self.spare_parts = spare_parts
            self.status = status
            new_service = {
                "technician_alloted": technician_id,
                "service_id": self.service_id,
                "product_id": self.product_id,
                "serial_no": self.serial_no,
                "purchase_date": purchase_date,
                "issue": issue,
                "image": image,   
                "status": status,
                "reason": "",
                "spare_parts": self.spare_parts
            }

            added_service = super().add(collection_name=collection_name, dictionary=new_service)

            logging.info("new service added successfully!")
            return added_service
        except Exception as e:
            logging.error("service addition was failed!")
            raise Exception(e)

    def delete_service(self, collection_name, query, many=False):
        try:
            deleted_service = super().delete_data(collection_name=collection_name, many=many, query=query)
            logging.info("service deleted successfully")
            return deleted_service
        except Exception as e:
            logging.error("service was not able to delete!")
            raise Exception(e)

    def update_service_status(self, service_status, reason: str, collection_name, query,image=None, spare_parts_used: bool = False):
        try:
            if service_status == "rejected":
                if not reason:
                    raise Exception("reason was not provided for rejected service")

            if service_status == "completed":
                if spare_parts_used:
                    if not image:
                        raise Exception("image proof is required to close the service since spare parts were used")
                else:
                    existing = super().get_data(collection_name=collection_name, query=query)
                    if not existing or not existing[0].get("manager_confirmed_return"):
                        raise Exception("service cannot be closed until the inventory manager confirmsthe returned spare part")

            update_values = {
                "status": service_status,
                "reason": reason,
                "spare_parts_used": spare_parts_used
            }
            if image:
                update_values["image"] = image

            service = super().update_data(collection_name=collection_name,update_values=update_values, query=query)
            logging.info("service status was updated!")
            return service

        except Exception as e:
            logging.error("service completion was failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("data fetching was failed!")
            raise Exception(e) 