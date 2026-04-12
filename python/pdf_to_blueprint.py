#!/usr/bin/env python3.8
"""
PDF → V4 Blueprint (One-Shot) — 豆包 Seed 2.0 Pro version
Combines storyboard parsing + V4 conversion into a single AI call.
Usage: python3.8 pdf_to_blueprint.py --pdf <path> --schema-file <path> --templates-file <path> [--orientation landscape] [--target-frames 11]
Output: JSON to stdout, progress to stderr (PROGRESS:<percent>:<stage>)
"""
import os, sys, json, time, argparse, base64, urllib.request, ssl
from io import BytesIO

os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)
os.environ.pop('https_proxy', None)
os.environ.pop('http_proxy', None)

DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
DOUBAO_KEY = os.environ.get('DOUBAO_API_KEY', '197cb950-3cf3-4b30-b656-6afaa4306a7a')
MODEL = os.environ.get('DOUBAO_MODEL', 'doubao-seed-2-0-pro-260215')


def log(msg):
    print(f"[pdf2bp] {msg}", file=sys.stderr, flush=True)

def progress(percent, stage):
    print(f"PROGRESS:{percent}:{stage}", file=sys.stderr, flush=True)


def pdf_to_images(pdf_path, dpi=150, quality=85, max_dimension=2048):
    """Convert PDF pages to WebP base64 image_url list for Doubao vision"""
    import fitz  # PyMuPDF
    try:
        from PIL import Image
    except ImportError:
        Image = None

    size = os.path.getsize(pdf_path)
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    log(f"PDF: {size} bytes, {page_count} pages, rendering at {dpi} DPI")

    image_urls = []
    for i, page in enumerate(doc):
        rect = page.rect
        scale = dpi / 72
        raw_w = int(rect.width * scale)
        raw_h = int(rect.height * scale)
        if max(raw_w, raw_h) > max_dimension:
            scale = scale * max_dimension / max(raw_w, raw_h)

        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat)
        png_bytes = pix.tobytes("png")

        if Image:
            img = Image.open(BytesIO(png_bytes))
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=quality)
            webp_bytes = buf.getvalue()
            b64 = base64.b64encode(webp_bytes).decode("ascii")
            mime = "image/webp"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} -> WebP {len(webp_bytes)//1024}KB")
        else:
            b64 = base64.b64encode(png_bytes).decode("ascii")
            mime = "image/png"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} -> PNG {len(png_bytes)//1024}KB")

        image_urls.append(f"data:{mime};base64,{b64}")

    doc.close()
    return image_urls


def call_doubao(system_prompt, user_content, max_tokens=65536):
    """Call 豆包 Seed 2.0 Pro, emit progress to stderr"""
    url = f"{DOUBAO_BASE}/chat/completions"
    log(f"Calling 豆包 {MODEL} (max_tokens={max_tokens})...")
    t0 = time.time()

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
    }

    data = json.dumps(body).encode('utf-8')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {DOUBAO_KEY}',
    }

    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    progress(25, "AI 分析中...")

    try:
        with urllib.request.urlopen(req, timeout=600, context=ctx) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        log(f"HTTP {e.code}: {error_body[:500]}")
        raise Exception(f"Doubao API error {e.code}: {error_body[:200]}")

    elapsed = time.time() - t0

    text = ""
    choices = result.get("choices", [])
    if choices:
        text = choices[0].get("message", {}).get("content", "")

    finish = choices[0].get("finish_reason", "unknown") if choices else "unknown"
    usage = result.get("usage", {})
    log(f"Done: {len(text)} chars, finish={finish}, tokens={usage.get('total_tokens', '?')} in {elapsed:.1f}s")

    return text, finish


def repair_json(text):
    """Fix common LLM JSON issues: trailing commas, single-line comments"""
    import re
    # Remove single-line comments (// ...)
    text = re.sub(r'//[^\n]*', '', text)
    # Remove trailing commas before } or ]
    text = re.sub(r',\s*([}\]])', r'\1', text)
    return text

def extract_json(text):
    """Extract JSON from model output"""
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()

    # Try raw first, then repaired
    for attempt_text in [text, repair_json(text)]:
        try:
            return json.loads(attempt_text)
        except json.JSONDecodeError:
            pass

    # Fallback: extract outermost {...} and repair
    import re
    m = re.search(r'\{[\s\S]*\}', text)
    if m:
        for attempt_text in [m.group(), repair_json(m.group())]:
            try:
                return json.loads(attempt_text)
            except json.JSONDecodeError:
                pass
    raise ValueError(f"No valid JSON found in {len(text)} chars")


def main():
    parser = argparse.ArgumentParser(description='PDF -> V4 Blueprint (One-Shot, 豆包)')
    parser.add_argument('--pdf', help='PDF file path')
    parser.add_argument('--images', nargs='*', help='Image file paths')
    parser.add_argument('--text', default='', help='User text/notes')
    parser.add_argument('--schema-file', required=True, help='V4 schema JSON file')
    parser.add_argument('--templates-file', required=True, help='Behavior templates MD file')
    parser.add_argument('--orientation', default='landscape', help='landscape or portrait')
    parser.add_argument('--target-frames', type=int, default=11, help='Target frame count')
    parser.add_argument('--max-tokens', type=int, default=65536)
    args = parser.parse_args()

    progress(5, "读取文件...")

    with open(args.schema_file, 'r', encoding='utf-8') as f:
        v4_schema = f.read()
    with open(args.templates_file, 'r', encoding='utf-8') as f:
        templates = f.read()[:3000]

    progress(8, "渲染 PDF 图片...")

    # Prepare image content (OpenAI-compatible multimodal format)
    user_content = []
    if args.pdf:
        image_urls = pdf_to_images(args.pdf)
        for url in image_urls:
            user_content.append({"type": "image_url", "image_url": {"url": url}})
    if args.images:
        for img_path in args.images:
            if os.path.exists(img_path):
                with open(img_path, 'rb') as f:
                    b64 = base64.b64encode(f.read()).decode('ascii')
                ext = img_path.rsplit('.', 1)[-1].lower()
                mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp'}.get(ext, 'image/jpeg')
                user_content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

    progress(15, "构建 AI 提示词...")

    target = args.target_frames
    orientation_desc = '竖屏（手机竖握）' if args.orientation == 'portrait' else '横屏（手机横握）'

    system_prompt = f"""你是试玩广告蓝图架构师。你需要一步完成：从分镜 PDF/图片直接提取游戏蓝图。

## 任务
分析输入的分镜文档/图片，直接输出 V4 实体驱动蓝图 JSON。

## 第一步：理解分镜
仔细阅读 PDF/图片中的每个画面和文字说明，理解：
- 游戏类型和核心玩法
- 场景中出现的所有物体/角色
- 玩家的操作方式（点击/拖拽/滑动/摇杆）
- 镜头的角度和运动
- 每个步骤的目标和过渡条件

## 第二步：提取实体和阶段
- **实体为中心**：每个游戏对象（角色、建筑、道具、UI、敌人、特效）都是独立实体
- **条件驱动**：Phase 只管"激活哪些实体"和"结束条件"
- 实体有明确的视觉属性、生成条件、行为模板
- 分 {target} 个左右的阶段（Phase），对应分镜的主要步骤

## 第三步：输出帧信息（用于展示）
同时输出 storyboardFrames 数组，每帧包含：
- id: 帧序号
- title: 中文标题
- scene: 场景描述（至少 80 字）
- interaction: 交互描述（至少 100 字）
- camera: 镜头描述
- ui: UI 说明
- timing: 持续时间
- animation: 动画说明
- scriptExcerpt: 对应的原始文案（从 PDF 中摘录）

## V4 Schema
{v4_schema}

## 行为模板
{templates}

## 输出格式
返回纯 JSON（不要 markdown code fence）：
{{
  "storyboardFrames": [{{ "id": 1, "title": "...", "scene": "...", "interaction": "...", "camera": "...", "ui": "...", "timing": "...", "animation": "...", "scriptExcerpt": "..." }}],
  "entities": [{{ V4 实体 }}],
  "phases": [{{ V4 阶段 }}],
  "globalSettings": {{ "gameType": "...", "cameraMode": "...", "cameraProjection": "orthographic" }}
}}

## 约束
- 帧数控制在 {target-1} 到 {target+1} 帧
- 适配{orientation_desc}布局
- 每个实体有唯一英文 name 和中文 label
- 模板类型必须是 Schema 中定义的类型
- 触发条件用 "phase:1" 或 "entity:X.state==built" 格式
- 最后一个阶段必须包含 CTA（Luna.Unity.Playable.InstallFullGame）"""

    user_text = "请分析这份分镜文档，直接输出完整的 V4 蓝图 JSON（包含 storyboardFrames + entities + phases + globalSettings）。"
    if args.text:
        user_text += f"\n\n补充说明：{args.text}"
    user_content.append({"type": "text", "text": user_text})

    log(f"System prompt: {len(system_prompt)} chars, images: {len([c for c in user_content if c.get('type') == 'image_url'])}")

    progress(20, "调用豆包 AI 分析分镜并生成蓝图...")

    raw, finish = call_doubao(system_prompt, user_content, args.max_tokens)

    progress(88, "解析 JSON...")

    try:
        data = extract_json(raw)
    except Exception as e:
        json.dump({
            "error": str(e),
            "finish_reason": finish,
            "raw_length": len(raw),
        }, sys.stdout, ensure_ascii=False)
        sys.exit(1)

    if 'entities' not in data or not isinstance(data.get('entities'), list):
        json.dump({"error": "Missing entities array"}, sys.stdout, ensure_ascii=False)
        sys.exit(1)
    if 'phases' not in data or not isinstance(data.get('phases'), list):
        json.dump({"error": "Missing phases array"}, sys.stdout, ensure_ascii=False)
        sys.exit(1)

    progress(95, f"完成！{len(data.get('entities', []))} 实体, {len(data.get('phases', []))} 阶段, {len(data.get('storyboardFrames', []))} 帧")

    json.dump({
        "data": data,
        "meta": {"finish_reason": finish, "model": MODEL, "parser": "pdf2bp-doubao"}
    }, sys.stdout, ensure_ascii=False)
    sys.exit(0)


if __name__ == '__main__':
    main()
