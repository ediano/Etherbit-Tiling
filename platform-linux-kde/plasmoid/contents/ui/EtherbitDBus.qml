/*
 * EtherbitDBus.qml — ponte D-Bus do applet, sem C++ (ADR 0059).
 *
 * O applet do System Tray NÃO fala D-Bus tipado nem empurra estado para o daemon: ele apenas
 *  (a) DISPARA ações nomeadas do KWin Script via kglobalaccel `invokeShortcut` — o mesmo canal do
 *      helper de preview (ADR 0039), mantendo a lógica KDE no KDE;
 *  (b) LÊ a config do daemon (`GetConfig`) só para refletir estado no popup;
 *  (c) abre o KCM de KWin Scripts.
 * Tudo via o motor "executable" do Plasma5Support (qdbus6/kcmshell6) — coerente com a filosofia de
 * ponte fina do projeto. Best-effort: se o daemon/KWin não responder, vira no-op silencioso.
 */
import QtQuick
import org.kde.plasma.plasma5support as Plasma5Support

Item {
    id: root

    // service/path/iface do daemon (fonte da verdade: daemon/src/service.rs:16-17, :91).
    readonly property string tilingService: "dev.ediano.etherbit.Tiling"
    readonly property string tilingPath: "/dev/ediano/etherbit/Tiling"
    // Componente kglobalaccel dos atalhos do KWin Script (igual a preview/src/kglobalaccel.rs:14-16).
    readonly property string kgaService: "org.kde.kglobalaccel"
    readonly property string kgaPath: "/component/kwin"
    readonly property string kgaIface: "org.kde.kglobalaccel.Component"

    // Callbacks pendentes por nome-de-fonte (o nome da fonte É o comando executado).
    property var _pending: ({})
    property int _nonce: 0

    Plasma5Support.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []
        onNewData: function (source, data) {
            var cb = root._pending[source];
            delete root._pending[source];
            // Encerra a fonte, senão o comando re-executa em loop.
            disconnectSource(source);
            if (cb) {
                cb(data["exit code"], (data["stdout"] || ""), (data["stderr"] || ""));
            }
        }
    }

    // Executa `cmd`. Um sufixo-comentário `# N` único evita colisão de nome de fonte quando o MESMO
    // comando roda duas vezes (o motor não re-executa uma fonte já conectada) — inócuo para o shell.
    function _run(cmd, cb) {
        var source = cmd + " # " + (++root._nonce);
        if (cb) {
            root._pending[source] = cb;
        }
        executable.connectSource(source);
    }

    // qdbus6 com fallback para qdbus-qt6 (linha de corte Qt6, igual ao resto do KDE — ver ADR 0013).
    function _qdbus(args) {
        return "qdbus6 " + args + " 2>/dev/null || qdbus-qt6 " + args;
    }

    /// Dispara por nome uma ação registrada pelo KWin Script (EtherbitToggle{Enabled,Monitor,Workspace}).
    function invokeShortcut(name) {
        _run(_qdbus(kgaService + " " + kgaPath + " " + kgaIface + ".invokeShortcut " + name), null);
    }

    /// Lê a config do daemon e chama `cb(config|null)`. `config` é o objeto JSON de `GetConfig`.
    function readConfig(cb) {
        var args = tilingService + " " + tilingPath + " " + tilingService + ".GetConfig";
        _run(_qdbus(args), function (code, stdout) {
            if (code !== 0 || !stdout) {
                cb(null);
                return;
            }
            try {
                cb(JSON.parse(stdout.trim()));
            } catch (e) {
                cb(null);
            }
        });
    }

    /// Abre o KCM de KWin Scripts direto (sem passar pelo menu de Configurações de Janelas). Não há KCM
    /// próprio do Etherbit nem deep-link público para a engrenagem do script (ADR 0057/0059).
    function openSettings() {
        _run("kcmshell6 kcm_kwin_scripts 2>/dev/null || systemsettings kcm_kwin_scripts", null);
    }
}
