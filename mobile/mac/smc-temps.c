// Read-only AppleSMC temperature probe. Only commands 9 (metadata) and 5 (read).
// ABI/key mapping references: SMC-NOTES.md. No daemon, root access or SMC writes.
#include <IOKit/IOKitLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stddef.h>

typedef struct { uint8_t major,minor,build,reserved; uint16_t release; } Version;
typedef struct { uint16_t version,length; uint32_t cpu,gpu,memory; } Limits;
typedef struct { uint32_t size,type; uint8_t attributes; } KeyInfo;
typedef struct {
    uint32_t key;
    Version version;
    Limits limits;
    KeyInfo info;
    uint8_t result,status,command;
    uint32_t data;
    uint8_t bytes[32];
} Packet;
_Static_assert(sizeof(Packet)==80 && offsetof(Packet,bytes)==48,"SMC ABI mismatch");

static uint32_t four(const char *s) {
    return ((uint32_t)(uint8_t)s[0]<<24)|((uint32_t)(uint8_t)s[1]<<16)|
        ((uint32_t)(uint8_t)s[2]<<8)|(uint8_t)s[3];
}
static int read_call(io_connect_t connection,Packet *input,Packet *output) {
    size_t size=sizeof(*output);
    memset(output,0,sizeof(*output));
    return IOConnectCallStructMethod(connection,2,input,sizeof(*input),output,&size)==KERN_SUCCESS &&
        size==sizeof(*output) && output->result==0;
}
static double temperature(io_connect_t connection,const char *key) {
    Packet input={0},output={0};
    input.key=four(key);
    input.command=9;
    if(!read_call(connection,&input,&output))return NAN;
    KeyInfo info=output.info;
    if(!((info.type==four("flt ")&&info.size==4)||(info.type==four("sp78")&&info.size==2)))return NAN;
    input.info.size=info.size;
    input.command=5;
    if(!read_call(connection,&input,&output))return NAN;
    double value;
    if(info.type==four("flt ")) {
        float raw;
        memcpy(&raw,output.bytes,sizeof(raw));
        value=raw;
    } else value=(int16_t)(((uint16_t)output.bytes[0]<<8)|output.bytes[1])/256.0;
    return isfinite(value)&&value>=10&&value<=150?value:NAN;
}
static void sensors(io_connect_t connection,const char *const *keys,size_t count) {
    int written=0;
    putchar('[');
    for(size_t i=0;i<count;i++) {
        double value=connection?temperature(connection,keys[i]):NAN;
        if(!isfinite(value))continue;
        if(written++)putchar(',');
        printf("{\"key\":\"%s\",\"celsius\":%.6f}",keys[i],value);
    }
    putchar(']');
}
int main(void) {
    const char *const cpu[]={"Te05","Te0S","Te09","Te0H","Tp01","Tp05","Tp09","Tp0D","Tp0V","Tp0Y","Tp0b","Tp0e"};
    const char *const gpu[]={"Tg0G","Tg0H","Tg0K","Tg0L","Tg0d","Tg0e","Tg0j","Tg0k"};
    io_connect_t connection=0;
    io_service_t service=IOServiceGetMatchingService(kIOMainPortDefault,IOServiceMatching("AppleSMC"));
    if(service) {
        if(IOServiceOpen(service,mach_task_self(),0,&connection)!=KERN_SUCCESS)connection=0;
        IOObjectRelease(service);
    }
    printf("{\"source\":\"AppleSMC\",\"available\":%s,\"cpuSensors\":",connection?"true":"false");
    sensors(connection,cpu,sizeof(cpu)/sizeof(cpu[0]));
    printf(",\"gpuSensors\":");sensors(connection,gpu,sizeof(gpu)/sizeof(gpu[0]));
    puts("}");
    if(connection)IOServiceClose(connection);
    return 0;
}
