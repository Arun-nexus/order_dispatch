import yaml
from logger import logging
import os

base_dir = os.path.dirname(os.path.abspath(__file__))
def load_params()->dict:
    try:
        with open(os.path.join(base_dir,"params.yaml"),"r") as f:
            params = yaml.safe_load(f)
            logging.info("parameter file was found" if params else "parmeter file was not found on thye given location")
            return params
    except Exception as e:
        logging.error(f"error occurred in configuration.py")
        raise(e)
        