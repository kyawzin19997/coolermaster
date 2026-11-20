//! Accept the previous environment names for existing scripts and plugin installations.

pub fn var_os(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).or_else(|| name.strip_prefix("MASTERDECK_").and_then(|suffix| std::env::var_os(format!("HUBDECK_{suffix}"))))
}

pub fn var(name: &str) -> Result<String, std::env::VarError> {
    var_os(name).ok_or(std::env::VarError::NotPresent)?.into_string().map_err(std::env::VarError::NotUnicode)
}
