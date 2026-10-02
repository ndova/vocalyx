"""Hilangkan console window yang dibuat child process di Windows.

App (vocalyx.exe) dan engine (pythonw.exe) keduanya berjalan tanpa console.
Karena itu setiap child console-subsystem — ffmpeg, ffprobe, python.exe — yang
di-spawn tanpa `CREATE_NO_WINDOW` akan mendapat console baru yang allocate,
berkedip sebentar di layar, lalu hilang saat child selesai.

Shim ini menjadikan flag tersebut default untuk semua spawn di satu proses, jadi
tidak perlu menambahkan flag di tiap call site. Itu penting karena spawn yang
paling sering berkedip justru milik library pihak ketiga (audio_separator, pydub,
yt-dlp) yang tidak bisa kita ubah.
"""
import os
import subprocess

CREATE_NO_WINDOW = 0x0800_0000

_installed = False


def hide_child_consoles() -> None:
    """Pasang default CREATE_NO_WINDOW untuk seluruh subprocess.Popen di proses ini.

    Aman dipanggil berkali-kali, dan tidak menimpa `creationflags` yang memang
    sudah ditetapkan pemanggil.
    """
    global _installed
    if _installed or os.name != "nt":
        return
    _installed = True

    original_init = subprocess.Popen.__init__

    def patched_init(self, args, *a, **kw):
        if not kw.get("creationflags"):
            kw["creationflags"] = CREATE_NO_WINDOW
        return original_init(self, args, *a, **kw)

    subprocess.Popen.__init__ = patched_init
