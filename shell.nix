{ pkgs ? import <nixpkgs> { } }:
let
  unstable = import <nixpkgs-unstable> {};
in
pkgs.mkShell { buildInputs = with pkgs; [ unstable.deno elmPackages.elm ]; }
