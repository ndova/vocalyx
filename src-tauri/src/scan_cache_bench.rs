use super::*;

#[test]
fn second_scan_reuses_cache() {
    let dir = std::env::var("VOCLYX_BENCH_DIR").unwrap_or_default();
    if dir.is_empty() {
        println!("skip: set VOCLYX_BENCH_DIR ke folder uji untuk benchmark");
        return;
    }
    let mut g = match scan_cache().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.clear();
    drop(g);

    let t0 = std::time::Instant::now();
    let a = scan_music(dir.clone());
    let cold = t0.elapsed();

    let t1 = std::time::Instant::now();
    let b = scan_music(dir.clone());
    let warm = t1.elapsed();

    assert_eq!(a.len(), b.len(), "jumlah baris harus sama");
    assert!(!a.is_empty(), "folder uji harus berisi file audio");
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x.path, y.path, "urutan & path harus sama");
        assert_eq!(x.size_str, y.size_str);
        assert_eq!(x.dur, y.dur, "durasi harus identik (dari cache)");
        assert_eq!(x.album, y.album);
        assert_eq!(x.cover, y.cover, "cover harus identik");
    }
    println!(
        "COLD  {:>8.1} ms  ({} file)",
        cold.as_secs_f64() * 1000.0,
        a.len()
    );
    println!(
        "WARM  {:>8.1} ms  ({} file)",
        warm.as_secs_f64() * 1000.0,
        b.len()
    );
    println!(
        "speedup {:.1}x",
        cold.as_secs_f64() / warm.as_secs_f64().max(1e-9)
    );
    assert!(
        warm.as_secs_f64() < cold.as_secs_f64(),
        "scan kedua harus lebih cepat"
    );
}

#[test]
fn cache_invalidates_when_file_changes() {
    let dir = std::env::var("VOCLYX_BENCH_DIR2").unwrap_or_default();
    if dir.is_empty() {
        println!("skip: set VOCLYX_BENCH_DIR2 ke folder uji untuk benchmark");
        return;
    }
    let mut g = match scan_cache().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.clear();
    drop(g);

    let before = scan_music(dir.clone());
    assert!(!before.is_empty(), "folder uji harus berisi file audio");

    let target = std::path::PathBuf::from(&dir).join(
        std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.path().is_file())
            .unwrap()
            .file_name(),
    );
    let bytes = std::fs::read(&target).unwrap();
    std::fs::write(&target, &bytes).unwrap();
    let after = scan_music(dir.clone());
    assert_eq!(before.len(), after.len());
    assert_eq!(
        after.iter().find(|t| t.path == target.to_string_lossy()).map(|t| t.size),
        Some(bytes.len() as u64),
        "ukuran file harus terbaca ulang setelah file disentuh"
    );
    println!("cache invalidation OK");
}