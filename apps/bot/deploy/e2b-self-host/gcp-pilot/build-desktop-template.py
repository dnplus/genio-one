import os

from e2b import Template, default_build_logger

template = (
    Template()
    .from_image("ubuntu:22.04")
    .set_user("root")
    .set_workdir("/")
    .set_envs(
        {
            "DEBIAN_FRONTEND": "noninteractive",
            "DEBIAN_PRIORITY": "high",
        }
    )
    .run_cmd(
        "apt-get update && "
        "DEBIAN_FRONTEND=noninteractive apt-get install -y "
        "xserver-xorg x11-xserver-utils xvfb x11-utils xauth xfce4 xfce4-terminal "
        "sudo curl git wget xdotool scrot x11vnc net-tools netcat-openbsd dbus-x11 ca-certificates && "
        "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb "
        "-O /tmp/google-chrome.deb && "
        "DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb && "
        "rm -f /tmp/google-chrome.deb && "
        "rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*"
    )
    .git_clone(
        "https://github.com/e2b-dev/noVNC.git", "/opt/noVNC", branch="e2b-desktop"
    )
    .git_clone(
        "https://github.com/novnc/websockify.git",
        "/opt/noVNC/utils/websockify",
        branch="v0.12.0",
    )
    .make_symlink("/opt/noVNC/vnc.html", "/opt/noVNC/index.html")
    .set_user("user")
    .set_workdir("/home/user")
)

Template.build(
    template,
    alias=os.environ.get("E2B_DESKTOP_TEMPLATE_ALIAS", "desktop"),
    cpu_count=8,
    memory_mb=8192,
    on_build_logs=default_build_logger(),
)
