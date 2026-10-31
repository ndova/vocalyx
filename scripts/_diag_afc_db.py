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
        conn = sqlite3.connect(tmp)
        cur = conn.cursor()

        print('== base_location ==')
        for row in cur.execute("SELECT base_location_id, path FROM base_location"):
            print(' ', row)

        print('== item media_type != 8 (video/other) ==')
        try:
            for row in cur.execute("SELECT item_pid, media_type, title, base_location_id FROM item ORDER BY item_pid DESC LIMIT 30"):
                print(' ', row)
        except Exception as e:
            print(' fail', e)

        print('== non-music rows with extra info ==')
        try:
            for row in cur.execute("""SELECT i.item_pid, i.media_type, e.title, e.location, e.file_size, b.path
                       FROM item i
                       LEFT JOIN item_extra e ON e.item_pid=i.item_pid
                       LEFT JOIN base_location b ON b.base_location_id=i.base_location_id
                       WHERE i.media_type != 8 ORDER BY i.item_pid DESC LIMIT 30"""):
                print(' ', row)
        except Exception as e:
            print(' fail', e)

        print('== last 15 music rows (for comparison) ==')
        for row in cur.execute("""SELECT i.item_pid, i.media_type, e.title, e.location, e.file_size, b.path
                   FROM item i
                   LEFT JOIN item_extra e ON e.item_pid=i.item_pid
                   LEFT JOIN base_location b ON b.base_location_id=i.base_location_id
                   WHERE i.media_type = 8 ORDER BY i.item_pid DESC LIMIT 15"""):
            print(' ', row)

        print('== item_playback of non-music ==')
        for row in cur.execute("""SELECT p.item_pid, p.audio_format, p.bit_rate, p.codec_type, p.codec_subtype,
                   p.duration, p.sample_rate, p.format, p.has_video
                   FROM item_playback p JOIN item i ON i.item_pid=p.item_pid
                   WHERE i.media_type != 8 LIMIT 20"""):
            print(' ', row)

        print('== item_playback sample of music (last 3) ==')
        for row in cur.execute("""SELECT p.item_pid, p.audio_format, p.bit_rate, p.codec_type, p.codec_subtype,
                   p.duration, p.sample_rate, p.format, p.has_video
                   FROM item_playback p JOIN item i ON i.item_pid=p.item_pid
                   WHERE i.media_type = 8 ORDER BY p.item_pid DESC LIMIT 3"""):
            print(' ', row)

        print('== item_video rows ==')
        try:
            for row in cur.execute("SELECT COUNT(*) FROM item_video"):
                print(' count', row)
        except Exception as e:
            print(' fail', e)

        print('== schema item_extra media_kind distribution ==')
        for row in cur.execute("SELECT media_kind, COUNT(*) FROM item_extra GROUP BY media_kind"):
            print(' ', row)

        
        print('== real (3uTools?) video row detail ==')
        try:
            row = cur.execute("""SELECT i.item_pid, i.media_type, e.title, e.location, e.file_size
                        FROM item i JOIN item_extra e ON e.item_pid=i.item_pid
                        WHERE e.file_size > 100000000 AND i.media_type != 8 LIMIT 1""").fetchone()
            if row:
                pid = row[0]
                print(' found big-video', row)
                for tbl in ['item', 'item_extra', 'item_playback', 'item_state', 'item_stats', 'item_video']:
                    cols = [d[1] for d in cur.execute(f"PRAGMA table_info({tbl})").fetchall()]
                    vals = cur.execute(f"SELECT * FROM [{tbl}] WHERE item_pid=? LIMIT 1", (pid,)).fetchone()
                    if vals:
                        print(f' -- {tbl}:')
                        for c, v in zip(cols, vals):
                            if v not in (None, 0, b'', ''):
                                print(f'    {c} = {v!r}')
        except Exception as e:
            print(' fail', e)
        conn.close()
    await ld.close()

asyncio.run(main())
