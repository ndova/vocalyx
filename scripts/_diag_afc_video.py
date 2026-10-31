import asyncio, traceback

async def main():
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.afc import AfcService
    ld = await create_using_usbmux()
    async with AfcService(ld) as afc:
        async def ls(p):
            try:
                items = await afc.listdir(p)
                return items
            except Exception as e:
                print(f'{p}: fail {e}')
                return None
        items = await ls('/iTunes_Control')
        print('ITUNES_ROOT:', items)
        for d in ['Video', 'Videos']:
            p = '/iTunes_Control/' + d
            its = await ls(p)
            if its is not None:
                print(f'{p}: {len(its)} entries')
                for name in its[:10]:
                    try:
                        st = await afc.stat(p + '/' + name)
                        print('  ', name, '->', dict(st))
                    except Exception as ee:
                        print('  ', name, 'stat fail', ee)
        for d in ['Media', 'Media/100MOV']:
            its = await ls('/iTunes_Control/' + d)
            if its is not None:
                print(f'/iTunes_Control/{d}: {len(its)}; first5 {its[:5]}')
                if d == 'Media/100MOV':
                    for name in its[:5]:
                        try:
                            st = await afc.stat('/iTunes_Control/Media/100MOV/' + name)
                            print('  ', name, '->', dict(st))
                        except Exception as ee:
                            print('  ', name, 'stat fail', ee)
    await ld.close()

asyncio.run(main())
