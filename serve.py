"""
本地预览服务器（Windows 专用修复版）

为什么不用 `python -m http.server`：
  本机注册表里 .js 的 Content Type 被设成了 text/plain，
  浏览器对 <script type="module"> 强制 MIME 校验，会拒绝加载。
  这里直接重写 guess_type()，硬编码正确的 MIME，彻底绕过注册表。

用法：
  python serve.py [端口] [绑定地址]     默认 8123 0.0.0.0
  绑定 0.0.0.0 = 同一局域网的手机/平板也能访问（控制台会打印局域网地址）。
"""
import http.server
import os
import socket
import socketserver
import sys

EXT_MAP = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
}
DEFAULT_TYPE = "application/octet-stream"


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return EXT_MAP.get(ext, DEFAULT_TYPE)

    def end_headers(self):
        # 开发期禁用缓存，改完文件刷新即可生效
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 浏览器提前关连接（刷新、切页、预检取消）会抛 ConnectionResetError，
        # 没必要把整段 traceback 刷屏。
        import traceback
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        traceback.print_exc()


def lan_ips():
    """列出本机可被局域网访问的 IPv4（去重、去掉回环）。

    先用 UDP connect 拿「默认出口」地址（最可能就是手机该访问的那个），
    再补上主机名解析出来的其它地址（多网卡 / 虚拟机网卡）。
    """
    ips = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))       # 只选路由，不真正发包
        ips.append(s.getsockname()[0])
    except Exception:
        pass
    finally:
        s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except Exception:
        pass
    out = []
    for ip in ips:
        if ip and not ip.startswith("127.") and ip not in out:
            out.append(ip)
    return out


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    with Server((host, port), Handler) as httpd:
        print("Serving %s  (bind %s:%d)" % (root, host, port))
        print("  本机    -> http://localhost:%d" % port)
        if host == "0.0.0.0":
            ips = lan_ips()
            for i, ip in enumerate(ips):
                if i == 0:
                    print("  局域网  -> http://%s:%d   <<< 手机/平板就填这个" % (ip, port))
                else:
                    print("  (其它网卡 http://%s:%d —— 虚拟机/WSL 用的，手机通常连不上)" % (ip, port))
        sys.stdout.flush()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
