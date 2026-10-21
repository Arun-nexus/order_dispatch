from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone, timedelta
from gdrive_media import upload_base64_to_drive
import os
import uuid
import enum

MEDIA_STALE_DAYS = int(os.getenv("MEDIA_STALE_DAYS", "2"))
GDRIVE_PLACEHOLDER = "this file shifted to gdrive"


class ServiceFlowError(Exception):
    """A rule of the technician workflow was broken (wrong step, missing proof, not your service...).
    status_code is the HTTP code the API should answer with."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ServiceStatus(str, enum.Enum):

    active = "active"                      # assigned to the technician, not started yet
    in_progress = "in_progress"            # technician is working on it (wizard steps 1-3)
    pending_approval = "pending_approval"  # report submitted, waiting for the service manager
    completed = "completed"                # service manager approved (faulty part returned)
    rejected = "rejected"


# technician wizard: assigned -> spare_decision -> report -> pending_approval -> done
WORKFLOW_ORDER = ["assigned", "spare_decision", "report", "pending_approval", "done"]

# big base64 fields are left out of list endpoints; GET /service/media/{id} serves them for one service
SERVICE_LIST_PROJECTION = {"damage_image": 0, "final_image": 0, "faulty_parts.image": 0}


class service_detail(mongodbclient):

    def __init__(self, product_id: str = None, serial_no: str = None, status="active"):
        super().__init__()

        self.product_id = product_id
        self.serial_no = serial_no
        self.status = status
        self.spare_parts = ""
        self.service_id = str(uuid.uuid4())

    def add_service(self, technician_id, purchase_date: str, issue: str, image: str, video: str, collection_name: str,location: str = "indoor", spare_parts: str = "", status="active", created_by: str = None, product_name: str = "", model_no: str = ""):
        try:
            self.spare_parts = spare_parts
            self.status = status
            new_service = {
                "technician_alloted": technician_id,
                "service_id": self.service_id,
                "product_id": self.product_id,
                "product_name": (product_name or "").strip(),
                "model_no": (model_no or "").strip(),
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
                "scheduled_date": None,
                "schedule_history": [],
                "last_reminder_at": None,
                "media_updated_at": datetime.now(timezone.utc).isoformat() if (image or video) else None,
                # who raised this service ticket, and the date it was listed —
                # shown in the Service page's table/detail view and export
                "created_by": created_by,
                "created_at": datetime.now(timezone.utc).isoformat(),
                # technician workflow
                "workflow_step": "assigned",
                "spare_needed": None,
                "faulty_parts": [],
                "faulty_part_count": 0
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

    # ------------------------------------------------------------------
    # Technician workflow
    #   1. start_service      damaged product image + serial number
    #   2. save_spare_decision  spare part needed? (faulty part image + hologram number)
    #   3. submit_report      work done + new hologram of each replaced part
    #      -> status pending_approval, faulty_part_count goes up
    #   4. approve_completion / reject_report   (service manager only)
    #      -> completed only when the faulty part return is approved
    # ------------------------------------------------------------------
    @staticmethod
    def _is_image(value) -> bool:
        return isinstance(value, str) and value.startswith("data:image")

    @staticmethod
    def _later_step(current, target):
        cur = WORKFLOW_ORDER.index(current) if current in WORKFLOW_ORDER else 0
        return WORKFLOW_ORDER[max(cur, WORKFLOW_ORDER.index(target))]

    def _get_one(self, collection_name, service_id):
        rows = super().get_data(collection_name=collection_name, query={"service_id": service_id})
        if not rows:
            raise ServiceFlowError("service not found", 404)
        return rows[0]

    def _get_own_open_service(self, collection_name, service_id, username):
        svc = self._get_one(collection_name, service_id)
        if svc.get("technician_alloted") != username:
            raise ServiceFlowError("this service is not assigned to you", 403)
        if svc.get("status") not in ("active", "in_progress"):
            raise ServiceFlowError("this service can no longer be edited", 409)
        return svc

    def start_service(self, collection_name, service_id, username, damage_image, serial_no):
        svc = self._get_own_open_service(collection_name, service_id, username)
        serial_no = (serial_no or "").strip()
        if not self._is_image(damage_image):
            raise ServiceFlowError("image of the damaged product is required")
        if not serial_no:
            raise ServiceFlowError("serial number is required")

        ticket_serial = (svc.get("serial_no") or "").strip().lower()
        update_values = {
            "status": "in_progress",
            "workflow_step": self._later_step(svc.get("workflow_step"), "spare_decision"),
            "damage_image": damage_image,
            "has_damage_image": True,
            "tech_serial_no": serial_no,
            "serial_mismatch": bool(ticket_serial) and ticket_serial != serial_no.lower(),
        }
        if not svc.get("started_at"):
            update_values["started_at"] = datetime.now(timezone.utc).isoformat()
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values=update_values)
        logging.info(f"service {service_id} started")
        return update_values["serial_mismatch"]

    def save_spare_decision(self, collection_name, service_id, username, spare_needed: bool, parts: list):
        svc = self._get_own_open_service(collection_name, service_id, username)
        if svc.get("workflow_step") not in ("spare_decision", "report"):
            raise ServiceFlowError("start the service first (damaged product image and serial number)")

        clean = []
        if spare_needed:
            if not parts:
                raise ServiceFlowError("add at least one faulty spare part")
            seen = set()
            for p in parts:
                name = (p.get("part_name") or "").strip()
                holo = (p.get("old_hologram_number") or "").strip()
                if not name or not holo:
                    raise ServiceFlowError("each faulty part needs a name and its hologram number")
                if holo in seen:
                    raise ServiceFlowError(f"hologram number {holo} is entered twice")
                seen.add(holo)
                if not self._is_image(p.get("image")):
                    raise ServiceFlowError(f"image of the damaged part {name} is required")
                clean.append({"part_name": name, "old_hologram_number": holo, "image": p["image"], "has_image": True})

        update_values = {
            "spare_needed": bool(spare_needed),
            "faulty_parts": clean,
            "faulty_part_count": 0,          # counted only when the report is submitted
            "workflow_step": self._later_step(svc.get("workflow_step"), "report"),
        }
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values=update_values)
        logging.info(f"service {service_id}: spare part decision saved (needed={spare_needed})")
        return clean

    def submit_report(self, collection_name, service_id, username, work_done: str, new_holograms: dict, final_image=None):
        svc = self._get_own_open_service(collection_name, service_id, username)
        if svc.get("status") != "in_progress" or svc.get("workflow_step") != "report":
            raise ServiceFlowError("finish the previous steps before submitting the service report")
        work_done = (work_done or "").strip()
        if not work_done:
            raise ServiceFlowError("write what work was done in the service report")

        parts = svc.get("faulty_parts") or []
        spare_needed = bool(svc.get("spare_needed"))
        if spare_needed:
            for p in parts:
                new_holo = (new_holograms.get(p["old_hologram_number"]) or "").strip()
                if not new_holo:
                    raise ServiceFlowError(f"new hologram number of the replacement for {p['part_name']} is required")
                if new_holo == p["old_hologram_number"]:
                    raise ServiceFlowError(f"new hologram number for {p['part_name']} cannot be the same as the old one")
                p["new_hologram_number"] = new_holo

        update_values = {
            "status": "pending_approval",
            "workflow_step": "pending_approval",
            "work_done": work_done,
            "faulty_parts": parts,
            "faulty_part_count": len(parts) if spare_needed else 0,     # <- the faulty part counter goes up here
            "spare_parts_used": spare_needed,
            "spare_parts": ", ".join(p["part_name"] for p in parts) if spare_needed else "",
            "report_submitted_at": datetime.now(timezone.utc).isoformat(),
            "report_rejected_reason": "",
        }
        if final_image:
            if not self._is_image(final_image):
                raise ServiceFlowError("final photo must be an image")
            update_values["final_image"] = final_image
            update_values["has_final_image"] = True
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values=update_values)
        logging.info(f"service {service_id}: report submitted, waiting for manager approval")
        return svc

    def approve_completion(self, collection_name, service_id, approver: str, service_charges=None):
        """Service manager approves the faulty part return -> the ONLY place a workflow service becomes completed.
        Returns the parts list for the inventory swap (done by the API layer, before this is called)."""
        svc = self._get_one(collection_name, service_id)
        if svc.get("status") != "pending_approval":
            raise ServiceFlowError("only a service whose report is waiting for approval can be approved", 409)
        charges = service_charges if service_charges is not None else svc.get("service_charges")
        if charges is None or float(charges) < 0:
            raise ServiceFlowError("enter the service charges before approving")
        update_values = {
            "status": "completed",
            "workflow_step": "done",
            "service_charges": float(charges),
            "manager_confirmed_return": True,
            "approved_by": approver,
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "reason": "",
        }
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values=update_values)
        logging.info(f"service {service_id} approved by {approver}")
        return svc

    def pending_parts_for_swap(self, svc: dict) -> list:
        if not svc.get("spare_needed"):
            return []
        return [{"part_name": p["part_name"], "old_hologram_number": p["old_hologram_number"],
                 "new_hologram_number": p.get("new_hologram_number") or ""} for p in (svc.get("faulty_parts") or [])]

    def reject_report(self, collection_name, service_id, reason: str):
        svc = self._get_one(collection_name, service_id)
        if svc.get("status") != "pending_approval":
            raise ServiceFlowError("only a service whose report is waiting for approval can be sent back", 409)
        reason = (reason or "").strip()
        if not reason:
            raise ServiceFlowError("write the reason for sending the report back")
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values={
            "status": "in_progress",
            "workflow_step": "report",
            "faulty_part_count": 0,
            "manager_confirmed_return": False,
            "report_rejected_reason": reason,
        })
        logging.info(f"service {service_id}: report sent back")
        return svc

    def get_media(self, collection_name, service_id):
        svc = self._get_one(collection_name, service_id)
        return {
            "service_id": service_id,
            "technician_alloted": svc.get("technician_alloted"),
            "damage_image": svc.get("damage_image") or "",
            "final_image": svc.get("final_image") or "",
            "faulty_parts": [{"part_name": p.get("part_name"), "old_hologram_number": p.get("old_hologram_number"),
                              "new_hologram_number": p.get("new_hologram_number") or "", "image": p.get("image") or ""}
                             for p in (svc.get("faulty_parts") or [])],
        }

    # ------------------------------------------------------------------
    # Rescheduling + 24 hour reminders
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_schedule(value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ServiceFlowError("select the new service date")
        try:
            datetime.fromisoformat(value)          # accepts YYYY-MM-DD and YYYY-MM-DDTHH:MM
        except ValueError:
            raise ServiceFlowError("invalid date, use the date picker")
        return value

    def reschedule_service(self, collection_name, service_id, scheduled_date: str, reason: str, by: str):
        svc = self._get_one(collection_name, service_id)
        if svc.get("status") in ("completed", "rejected"):
            raise ServiceFlowError("a completed or rejected service cannot be rescheduled", 409)
        scheduled_date = self._parse_schedule(scheduled_date)
        reason = (reason or "").strip()
        now = datetime.now(timezone.utc).isoformat()
        history = list(svc.get("schedule_history") or []) + [{
            "from": svc.get("scheduled_date"), "to": scheduled_date, "reason": reason, "by": by, "at": now,
        }]
        super().update_data(collection_name=collection_name, query={"service_id": service_id}, update_values={
            "scheduled_date": scheduled_date,
            "schedule_reason": reason,
            "schedule_history": history,
            "last_reminder_at": now,          # the 24h reminder clock restarts from the new schedule
        })
        logging.info(f"service {service_id} rescheduled to {scheduled_date} by {by}")
        return svc

    def services_due_for_reminder(self, collection_name, hours: int = 24):
        """Services that are not completed/rejected and were not reminded about in the last `hours`."""
        rows = super().get_data(collection_name=collection_name,
                                query={"status": {"$in": ["active", "in_progress", "pending_approval"]}},
                                projection=SERVICE_LIST_PROJECTION)
        limit = datetime.now(timezone.utc) - timedelta(hours=hours)
        due = []
        for s in rows or []:
            raw = s.get("last_reminder_at") or s.get("created_at")
            try:
                last = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
            except Exception:
                last = None
            if last is None or last <= limit:
                due.append(s)
        return due

    def mark_reminded(self, collection_name, service_id):
        super().update_data(collection_name=collection_name, query={"service_id": service_id},
                            update_values={"last_reminder_at": datetime.now(timezone.utc).isoformat()})

    def technician_location(self, user_id):
        pass