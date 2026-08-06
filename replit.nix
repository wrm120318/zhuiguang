{ pkgs }: {
  deps = [
    # Node.js 20.x (项目 engines.node>=20 严格要求)
    pkgs.nodePackages.npm
    pkgs.nodejs-20_x
    # 构建必要工具链(tsx编译、better-sqlite3原生绑定)
    pkgs.bash
    pkgs.gcc
    pkgs.gnumake
    pkgs.which
    pkgs.coreutils
    pkgs.curl
    pkgs.git
  ];
}
