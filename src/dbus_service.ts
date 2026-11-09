import Gio from 'gi://Gio';

const IFACE: string = `<node>
  <interface name="com.System76.PopShell">
    <method name="FocusLeft"/>
    <method name="FocusRight"/>
    <method name="FocusUp"/>
    <method name="FocusDown"/>
    <method name="WindowFocus">
        <arg type="(uu)" direction="in" name="window"/>
    </method>
    <method name="WindowHighlight">
        <arg type="(uu)" direction="in" name="window"/>
    </method>
    <method name="WindowList">
        <arg type="a((uu)sss)" direction="out" name="args"/>
    </method>
    <method name="WindowQuit">
        <arg type="(uu)" direction="in" name="window"/>
    </method>
  </interface>
</node>`;

const PATH: string = '/com/System76/PopShell';

export class Service {
    dbus: any;
    id: any = null;

    FocusLeft: () => void = () => {};
    FocusRight: () => void = () => {};
    FocusUp: () => void = () => {};
    FocusDown: () => void = () => {};
    WindowFocus: (window: [number, number]) => void = () => {};
    WindowList: () => Array<[[number, number], string, string, string]> = () => [];
    WindowQuit: (window: [number, number]) => void = () => {};

    constructor() {
        this.dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    }

    /** Start owning the D-Bus name. Idempotent. */
    start() {
        if (this.id !== null) return;

        const onBusAcquired = (conn: any) => {
            try {
                this.dbus.export(conn, PATH);
            } catch (why) {
                log(`pop-shell: failed to export D-Bus service: ${why}`);
            }
        };

        function onNameAcquired() {}

        function onNameLost() {}

        this.id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'com.System76.PopShell',
            Gio.BusNameOwnerFlags.NONE,
            onBusAcquired,
            onNameAcquired,
            onNameLost,
        );
    }

    destroy() {
        if (this.id !== null) {
            Gio.bus_unown_name(this.id);
            this.id = null;
        }

        try {
            this.dbus.unexport();
        } catch (_why) {
            // Already unexported or the connection is gone.
        }
    }
}
