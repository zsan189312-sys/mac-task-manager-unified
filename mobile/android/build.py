#!/usr/bin/env python3
"""Build a small native APK using the installed official SDK; no Gradle daemon/dependencies."""
from pathlib import Path
import os,subprocess,shutil,zipfile,json,hashlib,secrets
root=Path(__file__).resolve().parent
sdk=Path(os.environ.get('ANDROID_HOME',str(Path.home()/'Library/Android/sdk')))
jdk=Path(os.environ.get('JAVA_HOME','/opt/homebrew/opt/openjdk@17'))
tools=sdk/'build-tools/36.0.0';jar=sdk/'platforms/android-36/android.jar';build=root/'build'
if not jar.exists() or not tools.exists():raise SystemExit('Install platforms;android-36 and build-tools;36.0.0 first.')
if build.exists():shutil.rmtree(build)
for d in ['classes','generated','dex']:(build/d).mkdir(parents=True,exist_ok=True)
env={**os.environ,'JAVA_HOME':str(jdk),'PATH':str(jdk/'bin')+os.pathsep+os.environ['PATH']}
def run(args):subprocess.run([str(a) for a in args],check=True,env=env)
run([tools/'aapt2','compile','--dir',root/'res','-o',build/'resources.zip'])
run([tools/'aapt2','link','-I',jar,'--manifest',root/'AndroidManifest.xml','--java',build/'generated','--auto-add-overlay','--min-sdk-version','28','--target-sdk-version','36','-o',build/'resources.apk',build/'resources.zip'])
sources=list((root/'src').rglob('*.java'))+list((build/'generated').rglob('*.java'))
run([jdk/'bin/javac','-encoding','UTF-8','--release','8','-classpath',jar,'-d',build/'classes',*sources])
run([tools/'d8','--release','--min-api','28','--lib',jar,'--output',build/'dex',*list((build/'classes').rglob('*.class'))])
shutil.copy2(build/'resources.apk',build/'unsigned.apk')
with zipfile.ZipFile(build/'unsigned.apk','a',compression=zipfile.ZIP_DEFLATED) as z:
    for f in (build/'dex').glob('*.dex'):z.write(f,f.name)
run([tools/'zipalign','-p','4',build/'unsigned.apk',build/'aligned.apk'])
private=Path.home()/'Library/Application Support/TMU-Mobile/signing';private.mkdir(parents=True,exist_ok=True);private.chmod(0o700)
keystore=private/'release.jks';password=private/'password'
if not keystore.exists():
    if password.exists():raise SystemExit('Signing password already exists; review the missing keystore before generating a replacement.')
    password.write_text(secrets.token_urlsafe(32));password.chmod(0o600)
    run([jdk/'bin/keytool','-genkeypair','-keystore',keystore,'-storepass:file',password,'-keypass:file',password,'-alias','tmu-mobile','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=TMU Mobile Release,OU=Personal Applications,O=TMU,C=CN'])
    keystore.chmod(0o600)
apk=build/'TaskManager-Mobile-v1.0.0.apk'
run([tools/'apksigner','sign','--ks',keystore,'--ks-key-alias','tmu-mobile','--ks-pass','file:'+str(password),'--out',apk,build/'aligned.apk'])
run([tools/'apksigner','verify','--verbose','--print-certs',apk]);run([tools/'zipalign','-c','-p','4',apk])
meta={'version':'1.0.0','targetSdk':36,'minSdk':28,'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()}
(build/'artifact.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta,indent=2))
