FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN touch .project-root
RUN grep -v -i -E '^(altgraph|clr_loader|pefile|proxy_tools|pyinstaller|pyinstaller-hooks-contrib|pythonnet|pywebview|pywin32|pywin32-ctypes)==' requirement.txt > requirement-linux.txt
RUN pip install --no-cache-dir -r requirement-linux.txt && pip install --no-cache-dir uvicorn
RUN python -c "import uvicorn, fastapi; print('uvicorn', uvicorn.__version__)"
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD exec python -m uvicorn app:app --host 0.0.0.0 --port $PORT