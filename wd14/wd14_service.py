"""
WD14 标签器独立服务（动漫图片专用标签模型）
接收 base64 图片，返回 WD14 标签 + rating，供审核系统作为辅助判据调用。

启动: python wd14_service.py  (默认端口 9898)
首次调用会自动下载模型（已配置 hf-mirror 镜像加速）
"""
import os

# 优先使用国内 HuggingFace 镜像下载模型
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import base64
import io

from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image

from imgutils.tagging import get_wd14_tags

app = FastAPI(title="WD14 Tagger Service", version="1.0.0")

# 模型名：SwinV2_v3 为默认（准确率/速度平衡）；eva02-large 更准但更慢
MODEL_NAME = os.environ.get("WD14_MODEL", "SwinV2_v3")


class TagRequest(BaseModel):
    image: str  # base64（不含 data: 前缀）


class TagResponse(BaseModel):
    success: bool
    rating: dict = {}
    general: dict = {}
    character: dict = {}
    model: str = MODEL_NAME
    error: str = ""


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/tag", response_model=TagResponse)
def tag_image(req: TagRequest):
    try:
        img_bytes = base64.b64decode(req.image)
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        # WD14 标签：rating（safe/questionable/explicit 分级）、general（一般标签）、character（角色）
        rating, general, character = get_wd14_tags(img, model_name=MODEL_NAME)
        return TagResponse(
            success=True,
            rating=dict(rating),
            general=dict(general),
            character=dict(character),
        )
    except Exception as e:
        return TagResponse(success=False, error=str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WD14_PORT", "9898"))
    print(f"[WD14] 标签器服务启动: http://127.0.0.1:{port}  模型: {MODEL_NAME}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
