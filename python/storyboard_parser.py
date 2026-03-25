#!/usr/bin/env python3.8
"""
Blueprint Storyboard Parser - Python version
Usage: python3.8 storyboard_parser.py --pdf <path> --system-prompt <path> --user-text <text> [--file-ids id1,id2] [--max-tokens 65536]
Output: JSON to stdout
"""
import os, sys, json, time, argparse

# Direct connection — no proxy needed (using relay or direct)
os.environ.pop('HTTPS_PROXY', None)
os.environ.pop('HTTP_PROXY', None)
os.environ.pop('https_proxy', None)
os.environ.pop('http_proxy', None)

from openai import OpenAI

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY',
    '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')

client = OpenAI(api_key=OPENAI_API_KEY, base_url=os.environ.get('OPENAI_BASE_URL', 'https://sub.mindrix.app/v1'), timeout=600)


def log(msg):
    """Log to stderr so stdout stays clean for JSON output"""
    print(f"[py-storyboard] {msg}", file=sys.stderr, flush=True)


def pdf_to_images(pdf_path, dpi=150, quality=85, max_dimension=2048):
    """Convert PDF pages to WebP base64 image_url list for GPT-5.4 vision.
    
    Relay (sub.mindrix.app) doesn't support /v1/files, and image_url rejects
    application/pdf MIME. So we render each page as WebP via PyMuPDF.
    WebP is ~60% smaller than JPEG at same quality.
    Large pages are scaled down to fit within max_dimension.
    """
    import fitz  # PyMuPDF
    import base64
    from io import BytesIO
    try:
        from PIL import Image
    except ImportError:
        Image = None

    size = os.path.getsize(pdf_path)
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    log(f"PDF: {size} bytes, {page_count} pages, rendering at {dpi} DPI → WebP q{quality} (max {max_dimension}px)")

    image_urls = []

    for i, page in enumerate(doc):
        rect = page.rect
        # Calculate scale: use DPI but cap at max_dimension
        scale = dpi / 72
        raw_w = int(rect.width * scale)
        raw_h = int(rect.height * scale)
        if max(raw_w, raw_h) > max_dimension:
            scale = scale * max_dimension / max(raw_w, raw_h)
            log(f"  page {i+1}: {raw_w}x{raw_h} too large, scaling down to {int(rect.width*scale)}x{int(rect.height*scale)}")

        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat)
        png_bytes = pix.tobytes("png")

        # Convert to WebP via Pillow (much smaller than JPEG/PNG)
        if Image:
            img = Image.open(BytesIO(png_bytes))
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=quality)
            webp_bytes = buf.getvalue()
            b64 = base64.b64encode(webp_bytes).decode("ascii")
            mime = "image/webp"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} → WebP {len(webp_bytes)//1024}KB")
        else:
            # Fallback: use PNG if Pillow not available
            b64 = base64.b64encode(png_bytes).decode("ascii")
            mime = "image/png"
            log(f"  page {i+1}/{page_count}: {pix.width}x{pix.height} → PNG {len(png_bytes)//1024}KB (no Pillow)")

        image_urls.append(f"data:{mime};base64,{b64}")

    doc.close()
    total_b64_kb = sum(len(u) for u in image_urls) // 1024
    log(f"PDF → {len(image_urls)} page images, total base64 ~{total_b64_kb}KB")
    return image_urls


def parse_storyboard(system_prompt, user_content, max_tokens=65536):
    """Call GPT-5.4 with streaming, return parsed content"""
    log(f"Calling GPT-5.4 (streaming, max_tokens={max_tokens})...")
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
    chunks = 0
    finish = ""
    last_log = time.time()
    
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
            chunks += 1
        if chunk.choices and chunk.choices[0].finish_reason:
            finish = chunk.choices[0].finish_reason
        if time.time() - last_log > 30:
            log(f"  progress: {len(full)} chars, {chunks} chunks, {time.time()-t0:.0f}s")
            last_log = time.time()
    
    elapsed = time.time() - t0
    log(f"Done: {len(full)} chars, {chunks} chunks, finish={finish} in {elapsed:.1f}s")
    
    return full, finish


def extract_json(text):
    """Extract and parse JSON from GPT output"""
    text = text.strip()
    # Remove markdown fences
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()
    
    # Try direct parse
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object or array
        start = min(
            (text.find(c) for c in '{[' if text.find(c) >= 0),
            default=-1
        )
        if start < 0:
            raise ValueError(f"No JSON found in {len(text)} chars of output")
        
        # Find matching end
        if text[start] == '{':
            end = text.rfind('}')
        else:
            end = text.rfind(']')
        
        if end <= start:
            raise ValueError("Incomplete JSON")
        
        data = json.loads(text[start:end+1])
    
    # Handle array wrapper: [{characterSheet, frames}] -> {characterSheet, frames}
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) and 'frames' in data[0]:
        log("Unwrapped single-element array wrapper")
        data = data[0]
    
    return data


def main():
    parser = argparse.ArgumentParser(description='Blueprint Storyboard Parser')
    parser.add_argument('--pdf', help='Path to PDF file to upload and parse')
    parser.add_argument('--file-id', help='Already-uploaded OpenAI file ID (skip upload)')
    parser.add_argument('--system-prompt-file', help='Path to file containing system prompt')
    parser.add_argument('--system-prompt', help='System prompt string (use file for long prompts)')
    parser.add_argument('--user-text', default='请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。',
                        help='User message text')
    parser.add_argument('--extra-text', default='', help='Additional context text')
    parser.add_argument('--max-tokens', type=int, default=65536)
    parser.add_argument('--raw-output', help='Save raw GPT output to this file')
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
    
    # Get PDF data — render pages as WebP images
    pdf_image_urls = []
    if not args.file_id and args.pdf:
        pdf_image_urls = pdf_to_images(args.pdf)
    
    # Build user content
    user_content = []
    if pdf_image_urls:
        for url in pdf_image_urls:
            user_content.append({"type": "image_url", "image_url": {"url": url}})
    elif args.file_id:
        user_content.append({"type": "file", "file": {"file_id": args.file_id}})
    
    text = args.user_text
    if args.extra_text:
        text += f"\n\n补充说明：{args.extra_text}"
    user_content.append({"type": "text", "text": text})
    
    # Call GPT-5.4
    raw_text, finish_reason = parse_storyboard(system_prompt, user_content, args.max_tokens)
    
    # Save raw output if requested
    if args.raw_output:
        with open(args.raw_output, 'w', encoding='utf-8') as f:
            f.write(raw_text)
        log(f"Raw output saved to {args.raw_output}")
    
    # Parse JSON
    try:
        data = extract_json(raw_text)
    except (json.JSONDecodeError, ValueError) as e:
        # Return error as JSON
        json.dump({
            "error": str(e),
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "raw_tail": raw_text[-500:] if raw_text else ""
        }, sys.stdout, ensure_ascii=False)
        sys.exit(1)
    
    # Add metadata
    result = {
        "data": data,
        "meta": {
            "finish_reason": finish_reason,
            "raw_length": len(raw_text),
            "model": "gpt-5.4",
            "parser": "python"
        }
    }
    
    # Output JSON to stdout
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.exit(0)


if __name__ == '__main__':
    main()
