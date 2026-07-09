from mongo.mongodb_connection import mongodbclient
from logger import logging
import datetime
import numpy as np
from pydantic import BaseModel
import uuid
class service_detail(mongodbclient):

    def __init__(self,product_id:str,serial_no:str,status="active",):
        
        self.product_id = product_id
        self.serial_no = serial_no
        self.spare_parts = ""

    def add_service(self,purchase_date:str,issue:str,image:np.array,video:np.array,collection_name:str,spare_parts=str,status="active"):
        self.spare_parts = spare_parts
        try:
            self.status = status
            new_service = {
                "service_id":uuid.uuid4(),
                "product_id":self.product_id,
                "serial_no":self.serial_no,
                "purchase_date":purchase_date,
                "issue":issue,
                "image":image,
                "video":video,
                "status":status,
                "reason":"",
                "spare_parts":self.spare_parts
            } 

            added_service = super().add(collection_name=collection_name,dictionary=new_service)

            logging.info("new service added successfully!")
            return added_service
        except Exception as e:
            logging.error("service addition was failed!")
            raise Exception(e)
        
    def delete_Service(self,collection_name,query,reason:str,many=False):
        try:
            deleted_service = super().delete_data(collection_name=collection_name,many=many,query=query)
            logging.info("service deleted successfully")
            return deleted_service
        except Exception as e:
            logging.error("service was not able to delete!")
            raise Exception(e)
        
    def update_service_status(self,service_status,reason:str,collection_name,query,image,spare_parts_used:bool,manager_approval):
        try:
            if service_status == "rejected" and not reason:
                return "reason was not provided"
            if not manager_approval and service_status == "completed" and spare_parts_used and not image:    
                return "image was not provided of using spare parts please get the approval by the inventory manager of returning the product!"
            service = super().update_data(collection_name=collection_name,update_values=reason,query=query)
            logging.info("service status were updated!")
            return service
        except Exception as e:
            logging.error("service completion was failed!")
            raise Exception(e)
        
    def get_service_data(self,collection_name,query,projection):
        try:
            service = super().get_data(collection_name=collection_name,query=query,projection=projection)
            logging.info("service data was fetched succesfully!")
            return service
        except Exception as e:
            logging.error("fetching service records failed!")
            raise Exception(e)

        