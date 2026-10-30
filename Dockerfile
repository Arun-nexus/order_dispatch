FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN touch .project-root
RUN python -c "import re;b=open('requirement.txt','rb').read();t=b.decode('utf-16' if b[:2] in (b'\xff\xfe',b'\xfe\xff') else 'utf-8-sig');bad=re.compile(r'^(altgraph|clr_loader|pefile|proxy_tools|pyinstaller|pyinstaller-hooks-contrib|pythonnet|pywebview|pywin32|pywin32-ctypes)==',re.I);open('requirement-linux.txt','w').write(chr(10).join(l.strip() for l in t.splitlines() if l.strip() and not bad.match(l.strip()))+chr(10))" && test -s requirement-linux.txt && wc -l requirement-linux.txt
RUN pip install --no-cache-dir -r requirement-linux.txt
RUN python -c "import uvicorn, fastapi, pymongo, bson, twilio, dotenv; print('deps ok')"
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD exec python -m uvicorn app:app --host 0.0.0.0 --port $PORT