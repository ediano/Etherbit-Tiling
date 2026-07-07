/*
 * main.qml — System Tray Applet do Etherbit Tiling (ADR 0059).
 *
 * Ícone na bandeja + popup leve com acesso rápido: chave-mestra, toggles por monitor e por workspace,
 * e um atalho para as configurações. NÃO contém lógica de layout nem identidade de monitor — apenas
 * dispara ações do KWin Script (via EtherbitDBus/kglobalaccel) e reflete o estado lido do daemon.
 */
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root

    // Estado refletido do daemon (só leitura via GetConfig; a verdade vive no daemon/KWin Script).
    property bool tilingEnabled: false
    property int disabledGroupCount: 0

    Plasmoid.icon: "view-grid-symbolic"
    // Sempre visível na bandeja (acesso rápido é o propósito do applet).
    Plasmoid.status: PlasmaCore.Types.ActiveStatus
    toolTipMainText: i18n("Etherbit Tiling")
    toolTipSubText: tilingEnabled ? i18n("Tiling enabled") : i18n("Tiling disabled")

    preferredRepresentation: compactRepresentation

    EtherbitDBus {
        id: dbus
    }

    // Reconcilia o popup com o estado real do daemon logo após uma ação (o KWin Script aplica/persiste
    // de forma assíncrona; não assinamos ConfigChanged para manter o applet simples — ADR 0059).
    Timer {
        id: reconcile
        interval: 400
        onTriggered: root.refresh()
    }

    function refresh() {
        dbus.readConfig(function (cfg) {
            if (!cfg) {
                return;
            }
            root.tilingEnabled = cfg.enabled === true;
            root.disabledGroupCount = Array.isArray(cfg.disabled_groups) ? cfg.disabled_groups.length : 0;
        });
    }

    onExpandedChanged: if (expanded) {
        refresh();
    }
    Component.onCompleted: refresh()

    compactRepresentation: Kirigami.Icon {
        source: "view-grid-symbolic"
        active: compactMouse.containsMouse
        MouseArea {
            id: compactMouse
            anchors.fill: parent
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton
            onClicked: root.expanded = !root.expanded
        }
    }

    fullRepresentation: ColumnLayout {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 16
        Layout.maximumWidth: Kirigami.Units.gridUnit * 20
        spacing: Kirigami.Units.smallSpacing

        PlasmaExtras.Heading {
            Layout.fillWidth: true
            level: 3
            text: i18n("Etherbit Tiling")
        }

        // Chave-mestra: dispara EtherbitToggleEnabled (o KWin Script flipa o runtime + SetEnabled).
        RowLayout {
            Layout.fillWidth: true
            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: i18n("Enable tiling")
            }
            PlasmaComponents.Switch {
                checked: root.tilingEnabled
                onToggled: {
                    root.tilingEnabled = checked; // otimista; reconcile confirma com o daemon
                    dbus.invokeShortcut("EtherbitToggleEnabled");
                    reconcile.restart();
                }
            }
        }

        Kirigami.Separator {
            Layout.fillWidth: true
        }

        PlasmaComponents.Button {
            Layout.fillWidth: true
            icon.name: "video-display"
            text: i18n("Toggle tiling on this monitor")
            onClicked: {
                dbus.invokeShortcut("EtherbitToggleMonitor");
                reconcile.restart();
            }
        }
        PlasmaComponents.Button {
            Layout.fillWidth: true
            icon.name: "virtual-desktops"
            text: i18n("Toggle tiling on this workspace")
            onClicked: {
                dbus.invokeShortcut("EtherbitToggleWorkspace");
                reconcile.restart();
            }
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            visible: root.disabledGroupCount > 0
            wrapMode: Text.WordWrap
            text: i18np("%1 group with tiling off", "%1 groups with tiling off", root.disabledGroupCount)
        }

        Kirigami.Separator {
            Layout.fillWidth: true
        }

        PlasmaComponents.Button {
            Layout.fillWidth: true
            icon.name: "configure"
            text: i18n("Open settings…")
            onClicked: dbus.openSettings()
        }
    }
}
