import asyncio, os, sqlite3, tempfile

async def main():
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.afc import AfcService
    DB = '/iTunes_Control/iTunes/MediaLibrary.sqlitedb'
    ld = await create_using_usbmux()
    async with AfcService(ld) as afc:
        data = await afc.get_file_contents(DB)
        tmp = os.path.join(tempfile.gettempdir(), 'vx_scrub.db')
        open(tmp, 'wb').write(data)
        for s in ('-wal', '-shm'):
            try:
                blob = await afc.get_file_contents(DB + s)
                open(tmp + s, 'wb').write(blob)
            except Exception:
                pass

        conn = sqlite3.connect(tmp)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
            print('integrity before:', ok)
            
            
            
            cur = conn.cursor()
            cur.execute("""SELECT b.base_location_id, b.path
                           FROM base_location b
                           WHERE b.path NOT LIKE 'iTunes_Control/Music/F%'
                             AND b.base_location_id != 0""")
            for bid, path in cur.fetchall():
                cnt = conn.execute(
                    "SELECT COUNT(*) FROM item WHERE base_location_id=?", (bid,)).fetchone()[0]
                if cnt == 0:
                    conn.execute("DELETE FROM base_location WHERE base_location_id=?", (bid,))
                    print(f'removed base_location {bid} ({path}) - unreferenced')
                else:
                    print(f'kept base_location {bid} ({path}) - referenced by {cnt} item(s)')
            conn.commit()
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
            print('integrity after:', ok)
        finally:
            conn.close()

        
        conn2 = sqlite3.connect(tmp + '-vacuum' if False else tmp)
        try:
            try:
                conn2.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception as e:
                print('checkpoint warn:', e)
        finally:
            conn2.close()

        with open(tmp, 'rb') as f:
            await afc.set_file_contents(DB, f.read())
        for s in ('-wal', '-shm'):
            try:
                await afc.set_file_contents(DB + s, b'')
            except Exception:
                pass
    await ld.close()
    print('scrub done')

asyncio.run(main())
