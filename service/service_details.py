from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone, timedelta
from gdrive_media import upload_base64_to_drive
import os
import uuid
import enum

MEDIA_STALE_DAYS = int(os.getenv("MEDIA_STALE_DAYS", "2"))
GDRIVE_PLACEHOLDER = "this file shifted to gdrive"


class ServiceStatus(str, enum.Enum):
    
    active = "active"
    in_progress = "in_progress"
    completed = "completed"
    rejected = "rejected"

class service_detail(mongodbclient):

    def __init__(self, product_id: str = None, serial_no: str = None, status="active"):
        super().__init__()

        self.product_id = product_id
        self.serial_no = serial_no
        self.status = status
        self.spare_parts = ""
        self.service_id = str(uuid.uuid4())

    def add_service(self, technician_id, purchase_date: str, issue: str, image: str, video: str, collection_name: str,location: str = "indoor", spare_parts: str = "", status="active"):
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
                "video": video,
                "location": location,
                "status": status,
                "reason": "",
                "spare_parts": self.spare_parts,
                "spare_parts_requested": "",
                "service_charges": None,
                "manager_confirmed_return": False,
                "warranty_until": None,
                "media_updated_at": datetime.now(timezone.utc).isoformat() if (image or video) else None
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

    def update_service_status(self, service_status, reason: str, collection_name, query, image=None, video=None, spare_parts_used: bool = False, spare_parts: str = "", service_charges=None, parts_used: list = None):
        try:
            parts_used = parts_used or []
            if service_status not in [s.value for s in ServiceStatus]:
                raise Exception(f"invalid status: {service_status}")

            if service_status == "rejected" and not reason:
                raise Exception("reason was not provided for rejected service")

            if service_status == "completed":
                if not spare_parts or not spare_parts.strip():
                    raise Exception("spare part used must be written before marking service as completed")
                if spare_parts_used:
                    if not parts_used:
                        raise Exception("at least one spare part with its hologram numbers is required")
                    for p in parts_used:
                        if not p.get("part_name") or not p.get("old_hologram_number") or not p.get("new_hologram_number"):
                            raise Exception("each spare part needs a name, its old hologram number and its new hologram number")
                else:
                    existing = self.get_service_data(collection_name=collection_name, query=query)
                    if not existing or not existing[0].get("manager_confirmed_return"):
                        raise Exception("service cannot be closed until the inventory manager confirms the returned spare part")
                if service_charges is None:
                    raise Exception("service charges must be entered before marking service as completed")

            update_values = {
                "status": service_status,
                "reason": reason,
                "spare_parts_used": spare_parts_used
            }
            if spare_parts:
                update_values["spare_parts"] = spare_parts
            if spare_parts_used and parts_used:
                update_values["parts_replaced"] = parts_used
            if image:
                update_values["image"] = image
            if video:
                update_values["video"] = video
            if image or video:
                update_values["media_updated_at"] = datetime.now(timezone.utc).isoformat()
            if service_charges is not None:
                update_values["service_charges"] = service_charges

            service = super().update_data(collection_name=collection_name,update_values=update_values, query=query)
            logging.info("service status was updated!")
            return service
        except Exception as e:
            logging.error("service completion was failed!")
            raise Exception(e)

    def set_service_charges(self, collection_name, query, service_charges: float):
        try:
            result = super().update_data(collection_name=collection_name, query=query,
                                          update_values={"service_charges": service_charges})
            logging.info("service charges updated")
            return result
        except Exception as e:
            logging.error("service charges update failed!")
            raise Exception(e)

    def attach_media(self, collection_name, query, image=None, video=None):
        try:
            update_values = {}
            if image:
                update_values["image"] = image
            if video:
                update_values["video"] = video
            if not update_values:
                raise Exception("no image or video provided")
            update_values["media_updated_at"] = datetime.now(timezone.utc).isoformat()
            result = super().update_data(collection_name=collection_name, query=query, update_values=update_values)
            logging.info("service media updated")
            return result
        except Exception as e:
            logging.error("service media update failed!")
            raise Exception(e)

    def request_spare_part(self, collection_name, query, note: str):
        try:
            result = super().update_data(collection_name=collection_name, query=query,
                                          update_values={"spare_parts_requested": note})
            logging.info("spare part requested for service")
            return result
        except Exception as e:
            logging.error("spare part request failed!")
            raise Exception(e)

    def manager_confirm_return(self, collection_name, query):
        try:
            update_values = {"manager_confirmed_return": True}
            result = super().update_data(collection_name=collection_name,update_values=update_values, query=query)
            logging.info("inventory manager confirmed part return")
            return result
        except Exception as e:
            logging.error("manager confirmation failed!")
            raise Exception(e)

    def extend_warranty(self, collection_name, query, warranty_until: str):
        try:
            update_values = {"warranty_until": warranty_until}
            result = super().update_data(collection_name=collection_name, update_values=update_values, query=query)
            logging.info("warranty extended")
            return result
        except Exception as e:
            logging.error("warranty extension failed!")
            raise Exception(e)

    def get_service_data(self, collection_name, query=None, projection=None):
        try:
            self.migrate_stale_media(collection_name=collection_name)
            service = super().get_data(collection_name=collection_name, query=query, projection=projection)
            logging.info("service data was fetched successfully!")
            return service
        except Exception as e:
            logging.error("fetching service records failed!")
            raise Exception(e)

    def migrate_stale_media(self, collection_name):
        """
        Finds service records whose image/video is still a raw base64 blob and
        is older than MEDIA_STALE_DAYS (default 2 days), uploads that media to
        Google Drive, and replaces the field in Mongo with a placeholder string
        + the Drive link. Runs automatically on every get_service_data() call.
        Never raises - a Drive/network hiccup should not break page loads.
        """
        try:
            cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=MEDIA_STALE_DAYS)).isoformat()

            stale_docs = super().get_data(collection_name=collection_name, query={
                "media_updated_at": {"$ne": None, "$lt": cutoff_iso},
                "$or": [
                    {"image": {"$regex": "^data:"}},
                    {"video": {"$regex": "^data:"}}
                ]
            })

            if not stale_docs:
                return 0

            migrated_count = 0
            for doc in stale_docs:
                update_values = {}
                service_id = doc.get("service_id")

                image_val = doc.get("image") or ""
                if image_val.startswith("data:"):
                    try:
                        link = upload_base64_to_drive(image_val, filename=f"{service_id}_image")
                        update_values["image"] = GDRIVE_PLACEHOLDER
                        update_values["image_drive_link"] = link
                    except Exception as media_err:
                        logging.error(f"failed to migrate image for service {service_id}: {media_err}")

                video_val = doc.get("video") or ""
                if video_val.startswith("data:"):
                    try:
                        link = upload_base64_to_drive(video_val, filename=f"{service_id}_video")
                        update_values["video"] = GDRIVE_PLACEHOLDER
                        update_values["video_drive_link"] = link
                    except Exception as media_err:
                        logging.error(f"failed to migrate video for service {service_id}: {media_err}")

                if update_values:
                    super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values=update_values)
                    migrated_count += 1

            if migrated_count:
                logging.info(f"migrated media to Google Drive for {migrated_count} service record(s)")
            return migrated_count
        except Exception as e:
            logging.error(f"stale media migration skipped due to error: {e}")
            return 0

    def technician_location(self, user_id):
        pass