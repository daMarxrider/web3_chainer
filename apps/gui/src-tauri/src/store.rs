// The app's key/value store as files, with the same keys, layout and rules as the command line's
// `fileStore` (apps/cli/src/env.ts): a key is a relative path in the data folder, files are owner-only,
// and every write goes to a temporary file first and is renamed into place, so a crash mid-write
// cannot leave a half-written keystore or journal.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The command line's data folder, so the desktop app and the CLI share one wallet:
/// `CHAINER_HOME` if set, `%APPDATA%\chainer` on Windows, otherwise
/// `$XDG_CONFIG_HOME/chainer` or `~/.config/chainer`.
pub fn cli_data_dir() -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(home) = var("CHAINER_HOME") {
        return Some(home);
    }
    if cfg!(windows) {
        if let Some(appdata) = var("APPDATA") {
            return Some(appdata.join("chainer"));
        }
    }
    let config = var("XDG_CONFIG_HOME").or_else(|| var("HOME").map(|h| h.join(".config")))?;
    Some(config.join("chainer"))
}

pub struct FileStore {
    dir: PathBuf,
}

/// Makes temporary file names unique, so two writes of one key at the same time cannot mix.
static WRITES: AtomicU64 = AtomicU64::new(0);

impl FileStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The path for a key. Only plain names joined by `/` are accepted: no `..`, `.`, absolute
    /// paths, drive letters or backslashes, so a key can never lead outside the data folder.
    fn path_of(&self, key: &str) -> Result<PathBuf, String> {
        let refuse = || format!("Refusing to use \"{key}\": it is outside the data folder");
        if key.contains('\\') || key.contains(':') || key.contains('\0') {
            return Err(refuse());
        }
        let mut path = self.dir.clone();
        for part in key.split('/').filter(|p| !p.is_empty()) {
            match Path::new(part).components().next() {
                Some(Component::Normal(_)) => path.push(part),
                _ => return Err(refuse()),
            }
        }
        if key.starts_with('/') {
            return Err(refuse());
        }
        Ok(path)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        let path = self.path_of(key)?;
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Could not read {}: {e}", path.display())),
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let path = self.path_of(key)?;
        if path == self.dir {
            return Err(format!("Refusing to use \"{key}\": it names the data folder itself"));
        }
        let parent = path.parent().expect("a key path is inside the data folder");
        create_private_dir(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        let n = WRITES.fetch_add(1, Ordering::Relaxed);
        let tmp = PathBuf::from(format!("{}.{}-{n}.tmp", path.display(), std::process::id()));
        let written = write_private(&tmp, value).and_then(|()| fs::rename(&tmp, &path));
        written.map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("Could not write {}: {e}", path.display())
        })
    }

    /// The entries of the folder a prefix names, as keys (`prefix` + name), like the CLI's readdir.
    pub fn keys(&self, prefix: &str) -> Result<Vec<String>, String> {
        let path = self.path_of(prefix)?;
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(format!("Could not list {}: {e}", path.display())),
        };
        let mut keys = vec![];
        for entry in entries {
            let entry = entry.map_err(|e| format!("Could not list {}: {e}", path.display()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".tmp") {
                keys.push(format!("{prefix}{name}"));
            }
        }
        keys.sort();
        Ok(keys)
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

fn write_private(path: &Path, value: &str) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (FileStore, PathBuf) {
        let n = WRITES.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("chainer-store-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        (FileStore::new(dir.clone()), dir)
    }

    #[test]
    fn a_missing_key_reads_as_none() {
        let (s, _) = store();
        assert_eq!(s.get("settings.json").unwrap(), None);
    }

    #[test]
    fn a_written_value_reads_back() {
        let (s, dir) = store();
        s.set("transfers/a.json", "{\"x\":1}").unwrap();
        assert_eq!(s.get("transfers/a.json").unwrap().as_deref(), Some("{\"x\":1}"));
        assert_eq!(fs::read_to_string(dir.join("transfers").join("a.json")).unwrap(), "{\"x\":1}");
    }

    #[test]
    fn a_second_write_replaces_the_first() {
        let (s, _) = store();
        s.set("keystore.json", "old").unwrap();
        s.set("keystore.json", "new").unwrap();
        assert_eq!(s.get("keystore.json").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn keys_lists_the_folder_a_prefix_names_without_temporary_files() {
        let (s, dir) = store();
        s.set("routes/b.json", "1").unwrap();
        s.set("routes/a.json", "2").unwrap();
        s.set("settings.json", "3").unwrap();
        fs::write(dir.join("routes").join("c.json.tmp"), "half").unwrap();
        assert_eq!(s.keys("routes/").unwrap(), vec!["routes/a.json", "routes/b.json"]);
    }

    #[test]
    fn keys_of_a_folder_that_does_not_exist_is_empty() {
        let (s, _) = store();
        assert!(s.keys("schedules/").unwrap().is_empty());
    }

    #[test]
    fn keys_leading_outside_the_data_folder_are_refused() {
        let (s, _) = store();
        for key in ["../keystore.json", "routes/../../x", "/etc/passwd", "C:\\x", "a\\..\\b", "./x", "a/./b"] {
            assert!(s.set(key, "x").is_err(), "{key} was accepted");
            assert!(s.get(key).is_err(), "{key} was accepted");
        }
    }

    #[test]
    fn the_data_folder_itself_cannot_be_written() {
        let (s, _) = store();
        assert!(s.set("", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn files_and_folders_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (s, dir) = store();
        s.set("transfers/a.json", "x").unwrap();
        let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.join("transfers").join("a.json")), 0o600);
        assert_eq!(mode(dir.join("transfers")), 0o700);
        assert_eq!(mode(dir.clone()), 0o700);
    }
}
