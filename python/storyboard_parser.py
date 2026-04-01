#!/usr/bin/env python3.8
"""
Blueprint Storyboard Parser - 豆包 Seed 2.0 Pro version
Parses storyboard files (PDF/images/text) into blueprint frames.
Usage: python3.8 storyboard_parser.py --pdf <path> --system-prompt-file <path> --user-text <text> [--max-tokens 65536]
Output: JSON to stdout
"""
import os, sys, json, time, argparse, base64, urllib.request, ssl

os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)
os.environ.pop('https_proxy', None)
os.environ.pop('http_proxy', None)

DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
DOUBAO_KEY = os.environ.get('DOUBAO_API_KEY', '197cb950-3cf3-4b30-b656-6afaa4306a7a')
MODEL = os.environ.get('DOUBAO_MODEL', 'doubao-seed-2-0-pro-260215')


def log(msg):
    print(f"[py-storyboard] {msg}", file=sys.stderr, flush=True)


def pdf_to_images(pdf_path, dpi=150, quality=85, max_dimension=2048):
    """Convert PDF pages to base64 images for Doubao vision."""
    import fitz  # PyMuPDF
    from io import BytesIO
    try:
        from PIL import Image
    except ImportError:
        Image = None

    size = os.path.getsize(pdf_path)
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    log(f"PDF: {size} bytes, {page_count} pages, rendering at {dpi} DPI")

    images = []
    for i in range(page_count):
        page = doc[i]
        scale = dpi / 72.0
        if max(page.rect.width * scale, page.rect.height * scale) > max_dimension:
            scale = max_dimension / max(page.rect.width, page.rect.height)
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
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} -> {len(webp_bytes)//1024}KB")
        else:
            b64 = base64.b64encode(png_bytes).decode("ascii")
            mime = "image/png"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} -> PNG {len(png_bytes)//1024}KB")

        images.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"}
        })

    doc.close()
    log(f"PDF -> {len(images)} page images")
    return images


def call_doubao(system_prompt, user_content, max_tokens=65536):
    """Call 豆包 Seed 2.0 Pro via OpenAI-compatible API"""
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


def extract_json(text):
    """Extract and parse JSON from model output"""
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = min(
            (text.find(c) for c in '{[' if text.find(c) >= 0),
            default=-1
        )
        if start < 0:
            raise ValueError(f"No JSON found in {len(text)} chars of output")
        if text[start] == '{':
            end = text.rfind('}')
        else:
            end = text.rfind(']')
        if end <= start:
            raise ValueError("Incomplete JSON")
        data = json.loads(text[start:end+1])

    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) and 'frames' in data[0]:
        log("Unwrapped single-element array wrapper")
        data = data[0]

    return data


def main():
    parser = argparse.ArgumentParser(description='Blueprint Storyboard Parser (豆包 Seed 2.0 Pro)')
    parser.add_argument('--pdf', help='Path to PDF file')
    parser.add_argument('--file-id', help='(ignored, kept for compatibility)')
    parser.add_argument('--system-prompt-file', help='Path to file containing system prompt')
    parser.add_argument('--system-prompt', help='System prompt string')
    parser.add_argument('--user-text', default='请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。',
                        help='User message text')
    parser.add_argument('--extra-text', default='', help='Additional context text')
    parser.add_argument('--max-tokens', type=int, default=65536)
    parser.add_argument('--raw-output', help='Save raw output to this file')
    args = parser.parse_args()

    # Get system prompt
    if args.system_prompt_file:
        with open(args.system_prompt_file, 'r', encoding='utf-8') as f:
            system_prompt = f.read()
    elif args.system_prompt:
        system_prompt = args.system_prompt
    else:
        log("ERROR: --system-prompt or --system-prompt-file required")
        sys.exit(1)

    log(f"System prompt: {len(system_prompt)} chars")

    # Build user content (OpenAI-compatible multimodal format)
    user_content = []

    # PDF images
    if args.pdf and os.path.exists(args.pdf):
        images = pdf_to_images(args.pdf)
        user_content.extend(images)

    # User text
    text = args.user_text
    if args.extra_text:
        text += f"\n\n补充说明：{args.extra_text}"
    user_content.append({"type": "text", "text": text})

    # Call 豆包
    raw_text, finish_reason = call_doubao(system_prompt, user_content, args.max_tokens)

    # Save raw output
    if args.raw_output:
        with open(args.raw_output, 'w', encoding='utf-8') as f:
            f.write(raw_text)
        log(f"Raw output saved to {args.raw_output}")

    # Parse JSON
    try:
        data = extract_json(raw_text)
    except (json.JSONDecodeError, ValueError) as e:
        json.dump({
            "error": str(e),
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "raw_tail": raw_text[-500:] if raw_text else ""
        }, sys.stdout, ensure_ascii=False)
        sys.exit(1)

    result = {
        "data": data,
        "meta": {
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "model": MODEL,
            "parser": "python-doubao"
        }
    }

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.exit(0)


if __name__ == '__main__':
    main()
