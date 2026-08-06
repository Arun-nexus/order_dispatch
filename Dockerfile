FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN touch .project-root
RUN pip install --no-cache-dir -r requirement.txt
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD exec uvicorn app:app --host 0.0.0.0 --port $PORT