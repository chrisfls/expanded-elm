{ pkgs ? import <nixpkgs> { } }:
with pkgs;
mkShell { buildInputs = with pkgs; [ deno elmPackages.elm ]; }
