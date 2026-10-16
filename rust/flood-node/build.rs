// The Node-API functions come from the node binary when the addon loads.
fn main() {
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup"),
        Ok("linux") => println!("cargo:rustc-cdylib-link-arg=-Wl,-z,undefs"),
        _ => {}
    }
}
