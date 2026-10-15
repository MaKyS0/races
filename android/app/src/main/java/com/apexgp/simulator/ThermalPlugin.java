package com.apexgp.simulator;

import android.content.Context;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reports the OS thermal status so the game's governor can lower its own load.
 * It only reads PowerManager.getCurrentThermalStatus() (API 29+); it never tries to defeat throttling.
 * Returned state: nominal | fair | serious | critical.
 * NOT yet verified on a physical device (see docs/BUILD.md).
 */
@CapacitorPlugin(name = "Thermal")
public class ThermalPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        String state = "nominal";
        boolean powerSave = false;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                powerSave = pm.isPowerSaveMode();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    int s = pm.getCurrentThermalStatus();
                    if (s >= PowerManager.THERMAL_STATUS_SEVERE) state = "critical";
                    else if (s >= PowerManager.THERMAL_STATUS_MODERATE) state = "serious";
                    else if (s >= PowerManager.THERMAL_STATUS_LIGHT) state = "fair";
                }
            }
        } catch (Throwable ignored) { /* report nominal */ }
        JSObject r = new JSObject();
        r.put("state", state);
        r.put("powerSave", powerSave);
        call.resolve(r);
    }
}
