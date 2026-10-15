import Foundation
import Capacitor

/// Reports ProcessInfo.thermalState so the game's governor can lower its own load.
/// It never tries to defeat throttling. state: nominal | fair | serious | critical.
/// NOT compiled or run on a device from the Linux dev environment (see docs/BUILD.md).
@objc(ThermalPlugin)
public class ThermalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ThermalPlugin"
    public let jsName = "Thermal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    @objc func getState(_ call: CAPPluginCall) {
        let state: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: state = "nominal"
        case .fair: state = "fair"
        case .serious: state = "serious"
        case .critical: state = "critical"
        @unknown default: state = "nominal"
        }
        call.resolve(["state": state, "powerSave": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }
}
