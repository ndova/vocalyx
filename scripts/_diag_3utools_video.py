import asyncio, os, sqlite3, tempfile, traceback

async def main():
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.afc import AfcService
    ld = await create_using_usbmux()
    async with AfcService(ld) as afc:
        data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
        tmp = os.path.join(tempfile.gettempdir(), 'vx_diag_3utools.db')
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

    def cols(tbl):
        return [d[1] for d in cur.execute(f"PRAGMA table_info([{tbl}])").fetchall()]

    def row(tbl, pid):
        try:
            return cur.execute(f"SELECT * FROM [{tbl}] WHERE item_pid=?", (pid,)).fetchone()
        except Exception:
            return None

    print('========== SCHEMAS ==========')
    for tbl in ['item', 'item_extra', 'item_playback', 'item_state', 'item_video', 'item_store', 'container_item']:
        try:
            print(f'\n-- {tbl}:')
            for c in cols(tbl):
                print(f'   {c}')
        except Exception as e:
            print(f'   {tbl}: fail {e}')

    print('\n========== BASE_LOCATION (only non-Music) ==========')
    for row_ in cur.execute("SELECT base_location_id, path FROM base_location WHERE path NOT LIKE 'iTunes_Control/Music/%'"):
        print('   ', row_)

    print('\n========== MEDIA_KIND DISTRIBUTION ==========')
    for row_ in cur.execute("SELECT media_kind, COUNT(*) FROM item_extra GROUP BY media_kind"):
        print('   ', row_)

    print('\n========== VIDEO ROWS (media_type != 8) ==========')
    vids = cur.execute("""SELECT i.item_pid, e.title, e.location, e.file_size, b.path
                   FROM item i LEFT JOIN item_extra e ON e.item_pid=i.item_pid
                   LEFT JOIN base_location b ON b.base_location_id=i.base_location_id
                   WHERE i.media_type != 8 ORDER BY i.item_pid DESC""").fetchall()
    print(' total video rows:', len(vids))
    for v in vids:
        pid = v[0]
        print(f'\n--- VIDEO pid={pid} title={v[1]} loc={v[2]} size={v[3]} base={v[4]} ---')
        for tbl in ['item', 'item_extra', 'item_playback', 'item_state', 'item_stats', 'item_video', 'item_store', 'container_item', 'genre', 'album', 'item_artist', 'album_artist', 'item_search']:
            r = row(tbl, pid)
            if r:
                print(f'  [{tbl}]')
                for c, val in zip(cols(tbl), r):
                    if val != 0:
                        print(f'     {c} = {val!r}')
            else:
                print(f'  [{tbl}]: (no row)')

    print('\n========== MUSIC ROW (media_type=8, last one) ==========')
    mrow = cur.execute("""SELECT i.item_pid FROM item i WHERE i.media_type=8 ORDER BY i.item_pid DESC LIMIT 1""").fetchone()
    if mrow:
        pid = mrow[0]
        print(f'--- MUSIC pid={pid} ---')
        for tbl in ['item', 'item_extra', 'item_playback', 'item_state', 'item_stats', 'item_video', 'item_store', 'container_item']:
            r = row(tbl, pid)
            if r:
                print(f'  [{tbl}]')
                for c, val in zip(cols(tbl), r):
                    if val != 0:
                        print(f'     {c} = {val!r}')
            else:
                print(f'  [{tbl}]: (no row)')

    print('\n========== item_playback of all videos ==========')
    for row_ in cur.execute("""SELECT p.item_pid, p.audio_format, p.bit_rate, p.codec_type, p.codec_subtype,
                   p.duration, p.sample_rate, p.format, p.has_video
                   FROM item_playback p JOIN item i ON i.item_pid=p.item_pid
                   WHERE i.media_type != 8"""):
        print('   ', row_)

    conn.close()

try:
    asyncio.run(main())
except Exception:
    traceback.print_exc()
