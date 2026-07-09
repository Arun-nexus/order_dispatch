from mongo.mongodb_connection import mongodbclient
from logger import logging

class service_detail(mongodbclient):

    def __init__(self):
        pass
    def add_service(self):
        try:
            pass
        except Exception as e:
            logging.error("service addition was failed!")
            raise Exception(e)
        
    def delete_Service(self,reason):
        try:
            pass 
        except Exception as e:
            logging.error("service was not able to delete!")
            raise Exception(e)
        
    def complete_service(self,spare_parts_used:bool,cost:int,fault:str):
        try:
            pass
        except Exception as e:
            logging.error("service completion was failed!")
            raise Exception(e)
        
    def get_service_data(self):
        try:
            pass
        except Exception as e:
            logging.error("fetching service records failed!")
            raise Exception(e)
        
    def spare_parts_return(self):
        try:
            pass
        except Exception as e:
            logging.error("spare parts return confirmation was not available!")
            raise Exception(e)
        