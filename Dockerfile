FROM python:3.12-slim
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8765 INVESTMENT_DB=/data/investment.sqlite3 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY server.py numeric.py schema.sql fixtures.json archive.json ./
COPY public ./public
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8765/api/health',timeout=2)"
CMD ["python", "server.py"]
