import asyncio, os, sqlite3, tempfile

async def main():
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.afc import AfcService
    ld = await create_using_usbmux()
    async with AfcService(ld) as afc:
        data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
        tmp = os.path.join(tempfile.gettempdir(), 'vx_diag_media.db')
        open(tmp, 'wb').write(data)
        for s in ('-wal', '-shm'):
            try:
                blob = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb' + s)
                open(tmp + s, 'wb').write(blob)
            except Exception:
                pass
    await ld.close()
    conn = sqlite3.connect(tmp)
    cur = conn.cursor()
    print('non-music rows:', cur.execute(
        "SELECT i.item_pid, i.media_type, e.location FROM item i LEFT JOIN item_extra e ON e.item_pid=i.item_pid WHERE i.media_type != 8").fetchall())
    print('base 3940:', cur.execute("SELECT base_location_id, path FROM base_location WHERE base_location_id=3940").fetchall())
    conn.close()

asyncio.run(main())
