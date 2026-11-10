#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds assets/uidump.jar, the UI dumper ui_tree runs inside Android, for Android 11 and later.
# Downloads its toolchain into android/build/tools on first use; set TOOLS to reuse another copy,
# such as waydroid-app-displays' build/tools. Needs java.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
B=$HERE/build
TOOLS=${TOOLS:-$B/tools}
OUT=$HERE/../assets

fetch() { # file url sha256
    local file=$TOOLS/$1
    if [[ ! -f $file ]]; then
        echo "downloading $1"
        curl -fSL --retry 5 -C - -o "$file.part" "$2"
        mv "$file.part" "$file"
    fi
    echo "$3  $file" | sha256sum -c --quiet
}

mkdir -p "$TOOLS" "$OUT"
fetch ecj-3.40.0.jar https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.40.0/ecj-3.40.0.jar \
    05cc22a24e7982970f63a405fc6c820bc80b806f27f3c5a6236fc475f8f7152b
fetch r8.jar https://dl.google.com/android/maven2/com/android/tools/r8/8.5.35/r8-8.5.35.jar \
    4733945987ee0a840fafc34080b135259e01678412e07212b23f706334290294
fetch platform-33.zip https://dl.google.com/android/repository/platform-33_r02.zip \
    f851b13fe89f8510a1250df5e8593e86176b2428f4f3cbe0e304a85818c07bc8

ANDROID_JAR=$TOOLS/android-13/android.jar
[[ -f $ANDROID_JAR ]] || unzip -q -o "$TOOLS/platform-33.zip" 'android-13/android.jar' -d "$TOOLS"

rm -rf "$B/classes"
mkdir -p "$B/classes"
java -jar "$TOOLS/ecj-3.40.0.jar" -8 -proc:none -nowarn -encoding UTF-8 \
    -bootclasspath "$ANDROID_JAR" -d "$B/classes" $(find "$HERE/src" -name '*.java')
java -cp "$TOOLS/r8.jar" com.android.tools.r8.D8 --release --min-api 30 --lib "$ANDROID_JAR" \
    --output "$OUT/uidump.jar" $(find "$B/classes" -name '*.class')
echo "built $OUT/uidump.jar"
