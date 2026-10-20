FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 appuser \
    && chown appuser:appuser /app

COPY --chown=appuser:appuser main.py ./

USER appuser
EXPOSE 8000

# main.py lit PORT (fourni par Render) et écoute sur 0.0.0.0.
CMD ["python", "main.py"]
