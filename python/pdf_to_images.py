"""Convert large PDF pages to multiple JPEG images for API consumption.
Splits oversized pages into tiles to keep each under max_kb.
Returns list of base64-encoded JPEG strings."""
import os, sys, base64, io, json
import fitz
from PIL import Image

def pdf_to_images(pdf_path, max_kb=600, tile_max_dim=2048):
    """Convert PDF to list of base64 JPEG strings, splitting large pages into tiles."""
    doc = fitz.open(pdf_path)
    results = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        # Render at reasonable DPI first
        # For huge pages (>20 inches), use lower scale
        page_width_in = page.rect.width / 72
        page_height_in = page.rect.height / 72
        
        # Target ~3000px on longest side for the full page render
        target_px = 3000
        longest_in = max(page_width_in, page_height_in)
        dpi = min(150, int(target_px / longest_in * 72))
        dpi = max(72, dpi)
        
        pix = page.get_pixmap(dpi=dpi)
        img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        
        print(f"[pdf2img] Page {page_num+1}: {page_width_in:.0f}x{page_height_in:.0f}in → {img.width}x{img.height}px (dpi={dpi})", file=sys.stderr)
        
        # Check if single image is small enough
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=82)
        single_size = len(buf.getvalue())
        
        if single_size <= max_kb * 1024:
            b64 = base64.b64encode(buf.getvalue()).decode()
            results.append(b64)
            print(f"[pdf2img] Page {page_num+1}: single image {single_size//1024}KB", file=sys.stderr)
            continue
        
        # Need to tile — split into grid
        w, h = img.width, img.height
        cols = max(1, (w + tile_max_dim - 1) // tile_max_dim)
        rows = max(1, (h + tile_max_dim - 1) // tile_max_dim)
        
        # Ensure each tile is under max_kb
        while True:
            tile_w = w // cols
            tile_h = h // rows
            # Test one tile
            test_crop = img.crop((0, 0, tile_w, tile_h))
            tbuf = io.BytesIO()
            test_crop.save(tbuf, 'JPEG', quality=82)
            if len(tbuf.getvalue()) <= max_kb * 1024:
                break
            # Need more tiles
            if tile_w > tile_h:
                cols += 1
            else:
                rows += 1
            if cols * rows > 16:
                break
        
        print(f"[pdf2img] Page {page_num+1}: tiling {cols}x{rows} ({cols*rows} tiles)", file=sys.stderr)
        
        for row in range(rows):
            for col in range(cols):
                x1 = col * (w // cols)
                y1 = row * (h // rows)
                x2 = min(w, (col + 1) * (w // cols)) if col < cols - 1 else w
                y2 = min(h, (row + 1) * (h // rows)) if row < rows - 1 else h
                
                tile = img.crop((x1, y1, x2, y2))
                tbuf = io.BytesIO()
                tile.save(tbuf, 'JPEG', quality=82)
                data = tbuf.getvalue()
                b64 = base64.b64encode(data).decode()
                results.append(b64)
                print(f"[pdf2img]   Tile [{row},{col}]: {tile.width}x{tile.height} → {len(data)//1024}KB", file=sys.stderr)
    
    doc.close()
    return results

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: pdf_to_images.py <pdf_path>", file=sys.stderr)
        sys.exit(1)
    
    images = pdf_to_images(sys.argv[1])
    # Output as JSON array of base64 strings
    json.dump(images, sys.stdout)
    print(f"\n[pdf2img] Total: {len(images)} images", file=sys.stderr)
