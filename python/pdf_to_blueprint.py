#!/usr/bin/env python3.8
"""
PDF → V4 Blueprint (One-Shot)
Combines storyboard parsing + V4 conversion into a single AI call.
Usage: python3.8 pdf_to_blueprint.py --pdf <path> --schema-file <path> --templates-file <path> [--orientation landscape] [--target-frames 11]
Output: JSON to stdout, progress to stderr (PROGRESS:<percent>:<stage>)
"""
import os, sys, json, time, argparse, base64
from io import BytesIO

os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)
os.environ.pop('https_proxy', None)
os.environ.pop('http_proxy', None)

from openai import OpenAI

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY',
    'sk-7316ee056524c5ffb3c5920fa9d6ffcbcd8026fdc0fea386de50c5e2f4a083aa')

client = OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=os.environ.get('OPENAI_BASE_URL', 'https://sub.mindrix.app/v1'),
    timeout=600
)


def log(msg):
    print(f"[pdf2bp] {msg}", file=sys.stderr, flush=True)

def progress(percent, stage):
    """Structured progress line for Node.js SSE forwarding"""
    print(f"PROGRESS:{percent}:{stage}", file=sys.stderr, flush=True)


def pdf_to_images(pdf_path, dpi=150, quality=85, max_dimension=2048):
    """Convert PDF pages to WebP base64 image_url list for GPT vision"""
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
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} → WebP {len(webp_bytes)//1024}KB")
        else:
            b64 = base64.b64encode(png_bytes).decode("ascii")
            mime = "image/png"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} → PNG {len(png_bytes)//1024}KB")

        image_urls.append(f"data:{mime};base64,{b64}")

    doc.close()
    return image_urls


def call_gpt(system_prompt, user_content, max_tokens=65536):
    """Call GPT-5.4 with streaming, emit progress to stderr"""
    log(f"Calling GPT-5.4 (streaming)...")
    t0 = time.time()

    stream = client.chat.completions.create(
        model="gpt-5.4",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        max_completion_tokens=max_tokens,
        temperature=0.3,
        stream=True,
    )

    full = ""
    finish = ""
    last_progress = time.time()

    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
        if chunk.choices and chunk.choices[0].finish_reason:
            finish = chunk.choices[0].finish_reason
        now = time.time()
        if now - last_progress > 3:
            elapsed = now - t0
            # Estimate: typical output 20-40K chars over 60-120s
            chars = len(full)
            pct = min(85, 25 + int((chars / 30000) * 55))
            progress(pct, f"AI 生成中... {chars//1000}K 字符, {int(elapsed)}秒")
            last_progress = now

    elapsed = time.time() - t0
    log(f"Done: {len(full)} chars, finish={finish} in {elapsed:.1f}s")
    return full, finish


def extract_json(text):
    """Extract JSON from GPT output"""
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        import re
        m = re.search(r'\{[\s\S]*\}', text)
        if m:
            return json.loads(m.group())
        raise ValueError(f"No JSON found in {len(text)} chars")


def main():
    parser = argparse.ArgumentParser(description='PDF → V4 Blueprint (One-Shot)')
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

    # Load schema and templates
    with open(args.schema_file, 'r', encoding='utf-8') as f:
        v4_schema = f.read()
    with open(args.templates_file, 'r', encoding='utf-8') as f:
        templates = f.read()[:3000]

    progress(8, "渲染 PDF 图片...")

    # Prepare image content
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

    orientation_desc = '竖屏（手机竖握）' if args.orientation == 'portrait' else '横屏（手机横握）'
    target = args.target_frames

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

    progress(20, "调用 AI 分析分镜并生成蓝图...")

    # Single AI call
    raw, finish = call_gpt(system_prompt, user_content, args.max_tokens)

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

    # Validate
    if 'entities' not in data or not isinstance(data.get('entities'), list):
        json.dump({"error": "Missing entities array"}, sys.stdout, ensure_ascii=False)
        sys.exit(1)
    if 'phases' not in data or not isinstance(data.get('phases'), list):
        json.dump({"error": "Missing phases array"}, sys.stdout, ensure_ascii=False)
        sys.exit(1)

    progress(95, f"完成！{len(data.get('entities', []))} 实体, {len(data.get('phases', []))} 阶段, {len(data.get('storyboardFrames', []))} 帧")

    json.dump({
        "data": data,
        "meta": {"finish_reason": finish, "model": "gpt-5.4", "parser": "pdf2bp-oneshot"}
    }, sys.stdout, ensure_ascii=False)
    sys.exit(0)


if __name__ == '__main__':
    main()
