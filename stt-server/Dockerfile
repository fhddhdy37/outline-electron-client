FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
# nvidia pip wheels provide cuBLAS/cuDNN for ctranslate2 GPU inference;
# the driver itself comes from the host via the nvidia container runtime.
RUN pip install --no-cache-dir -r requirements.txt \
    nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"

# Make the pip-provided CUDA libraries visible to ctranslate2.
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib

COPY app.py .

EXPOSE 8765

CMD ["python", "app.py"]
