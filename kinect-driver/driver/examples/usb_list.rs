//! Lists the Kinect v2 devices libusb sees (no streaming).
//!   cargo run -p kinect-driver --example usb_list
#[cfg(feature = "usb-system")]
fn main() {
    use kinect_driver::usb::UsbBackend;
    match kinect_driver::usb::libusb::LibusbBackend::new() {
        Ok(b) => {
            println!("{}", b.name());
            match b.list() {
                Ok(l) if l.is_empty() => println!("no Kinect v2 found"),
                Ok(l) => {
                    for d in l {
                        println!("{d:?}");
                    }
                }
                Err(e) => println!("cannot list: {e}"),
            }
        }
        Err(e) => println!("libusb: {e}"),
    }
}

#[cfg(not(feature = "usb-system"))]
fn main() {
    println!("built without USB support");
}
